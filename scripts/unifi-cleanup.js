/* MongoDB 3.6 shell. The wrapper supplies cleanupConfig and checks the final marker. */
function cleanupNumber(value) {
    var number = value && typeof value.toNumber === "function" ? value.toNumber() : Number(value);
    if (!isFinite(number)) {
        throw new Error("Некорректное числовое значение MongoDB");
    }
    return number;
}

function cleanupIdentity(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (typeof value.toHexString === "function") {
        return value.toHexString();
    }
    if (value.str !== undefined) {
        return String(value.str);
    }
    return String(value);
}

function cleanupErrorText(error) {
    return String(error.message || error)
        .replace(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/gi, "[MAC]")
        .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, "[IP]")
        .replace(/\b[0-9a-f]{24}\b/gi, "[id]")
        .slice(0, 300);
}

function cleanupTimeQuery(field, cutoffMs) {
    var seconds = {};
    var milliseconds = {};
    var dates = {};
    seconds[field] = {$type: "number", $gte: 946684800, $lt: Math.floor(cutoffMs / 1000)};
    milliseconds[field] = {$type: "number", $gte: 946684800000, $lt: cutoffMs};
    dates[field] = {$type: "date", $gte: new Date(946684800000), $lt: new Date(cutoffMs)};
    return {$or: [seconds, milliseconds, dates]};
}

function cleanupUserQuery(context) {
    return {$and: [
        {name: {$exists: false}},
        {note: {$exists: false}},
        {fixed_ip: {$exists: false}},
        {blocked: {$ne: true}},
        {use_fixedip: {$ne: true}},
        {fixed_ap_enabled: {$ne: true}},
        {noted: {$ne: true}},
        {virtual_network_override_enabled: {$ne: true}},
        {virtual_network_override_id: {$in: [null, ""]}},
        {network_id: {$in: [null, ""]}},
        {vlan: {$in: [null, ""]}},
        {fixed_ap_mac: {$in: [null, ""]}},
        {fingerprint_override: {$exists: false}},
        {$or: [
            {last_1x_identities: {$exists: false}},
            {last_1x_identities: null},
            {last_1x_identities: {$size: 0}}
        ]},
        {usergroup_id: {$in: [null, ""].concat(context.defaultGroups)}},
        {mac: {$nin: context.deviceMacs}}
    ]};
}

function cleanupBatchQuery(base, ids, siteValue, sitePresent) {
    var site = {site_id: siteValue};
    if (!sitePresent) {
        site = {site_id: {$exists: false}};
    } else if (siteValue === null) {
        site = {site_id: {$eq: null, $exists: true}};
    }
    return {$and: [base, {_id: {$in: ids}}, site]};
}

function cleanupContext(config) {
    var ace = db.getSiblingDB("ace");
    var context = {sites: Object.create(null), defaultGroups: [], deviceMacs: []};
    ace.site.find({}, {_id: 1, desc: 1, name: 1}).maxTimeMS(config.maxTimeMS).forEach(function(site) {
        context.sites[cleanupIdentity(site._id)] = site.desc || site.name || "(неизвестный сайт)";
    });
    ace.usergroup.find({name: "Default"}, {_id: 1}).maxTimeMS(config.maxTimeMS).forEach(function(group) {
        context.defaultGroups.push(group._id);
        context.defaultGroups.push(cleanupIdentity(group._id));
    });
    ace.device.find({}, {mac: 1}).maxTimeMS(config.maxTimeMS).forEach(function(device) {
        if (typeof device.mac === "string") {
            context.deviceMacs.push(device.mac);
        }
    });
    return context;
}

function cleanupSizes() {
    var sizes = {data: 0, storage: 0, indexes: 0};
    ["ace", "ace_stat"].forEach(function(name) {
        var stats = db.getSiblingDB(name).stats();
        if (stats.ok !== 1) {
            throw new Error("Не удалось прочитать размеры базы " + name);
        }
        sizes.data += cleanupNumber(stats.dataSize);
        sizes.storage += cleanupNumber(stats.storageSize);
        sizes.indexes += cleanupNumber(stats.indexSize);
    });
    return sizes;
}

function cleanupPrintSizes(label, sizes) {
    function mib(bytes) {
        return (bytes / 1048576).toFixed(2);
    }
    print(label + ": данные=" + mib(sizes.data) + " MiB, выделенное хранение=" +
          mib(sizes.storage) + " MiB, индексы=" + mib(sizes.indexes) + " MiB");
}

function cleanupValidate(config) {
    if (config.mode !== "dry-run" && config.mode !== "apply" && config.mode !== "index-only") {
        throw new Error("Режим должен быть dry-run, apply или index-only");
    }
    if (config.mode === "index-only") {
        return;
    }
    ["batchSize", "maxPerCollection", "maxTotal", "maxSeconds", "maxTimeMS"].forEach(function(name) {
        if (typeof config[name] !== "number" || !isFinite(config[name]) ||
                config[name] < 1 || Math.floor(config[name]) !== config[name]) {
            throw new Error("Неверное ограничение " + name);
        }
    });
}

function cleanupMaintainIndex(config) {
    var database = db.getSiblingDB("ace");
    var collections = database.getCollectionNames();
    var jobs = [
        {collection: "user", name: "site_id_1_last_seen_-1", key: {site_id: 1, last_seen: -1}, required: true},
        {collection: "rogue", name: "site_id_1_last_seen_-1", key: {site_id: 1, last_seen: -1}},
        {collection: "reference_name_history", name: "delete_time_1", key: {delete_time: 1}}
    ];
    function suitableIndex(index, key) {
        var fields = Object.keys(index.key || {});
        var wanted = Object.keys(key);
        return fields.length === wanted.length && fields.every(function(field, position) {
            return field === wanted[position] && index.key[field] === key[field];
        }) && index.sparse !== true && index.partialFilterExpression === undefined &&
            index.collation === undefined && index.expireAfterSeconds === undefined;
    }
    jobs.forEach(function(job) {
        var label = "ace." + job.collection + " " + job.name;
        if (collections.indexOf(job.collection) < 0) {
            if (job.required) {
                throw new Error("Не найдена ace.user. Проверьте адрес MongoDB и завершение первоначальной настройки UniFi");
            }
            print("Индекс " + label + ": коллекция отсутствует, проверка пропущена");
            return;
        }
        var collection = database.getCollection(job.collection);
        var indexes = collection.getIndexes();
        if (indexes.length === 0) {
            throw new Error("Не найдены индексы ace." + job.collection + ". Проверьте завершение первоначальной настройки UniFi");
        }
        var found = false;
        indexes.forEach(function(index) {
            var suitable = suitableIndex(index, job.key);
            if (index.name === job.name && !suitable) {
                throw new Error("Имя индекса " + label + " занято индексом с другими параметрами");
            }
            found = found || suitable;
        });
        if (found) {
            print("Индекс " + label + ": подходящий индекс уже есть");
            return;
        }
        if (config.mode === "dry-run") {
            print("Индекс " + label + ": отсутствует; будет добавлен при apply");
            return;
        }
        var result = collection.createIndex(job.key, {name: job.name, background: true});
        if (result !== job.name && (!result || result.ok !== 1)) {
            throw new Error("Создание индекса " + label + " не подтверждено MongoDB");
        }
        var confirmed = collection.getIndexes().some(function(index) {
            return index.name === job.name && suitableIndex(index, job.key);
        });
        if (!confirmed) {
            throw new Error("Индекс " + label + " не подтверждён повторным чтением getIndexes");
        }
        print("Индекс " + label + ": создан в фоне");
    });
}

function cleanupPerformanceCheck(config, context) {
    var users = db.getSiblingDB("ace").getCollection("user");
    Object.keys(context.sites).sort().forEach(function(site) {
        var explanation = users.find({site_id: site}).sort({last_seen: -1}).limit(100)
            .maxTimeMS(config.maxTimeMS).explain("executionStats");
        if (!explanation || explanation.ok === 0 || !explanation.executionStats ||
                explanation.executionStats.executionSuccess === false ||
                !explanation.queryPlanner || !explanation.queryPlanner.winningPlan) {
            throw new Error("Не подтверждена проверка ace.user для сайта " + context.sites[site]);
        }
        var stats = explanation.executionStats;
        var plan = explanation.queryPlanner.winningPlan;
        if (plan.queryPlan) {
            plan = plan.queryPlan;
        }
        while (plan && !plan.indexName) {
            plan = plan.inputStage;
        }
        print("Проверка ace.user, сайт=" + context.sites[site] + ", лимит=100, время=" +
              cleanupNumber(stats.executionTimeMillis) + " мс, возвращено=" + cleanupNumber(stats.nReturned) +
              ", документов=" + cleanupNumber(stats.totalDocsExamined) +
              ", ключей=" + cleanupNumber(stats.totalKeysExamined) +
              ", индекс=" + (plan ? plan.indexName : "не указан"));
    });
}

function cleanupResourceReport(config) {
    try {
        var status = db.getSiblingDB("admin").serverStatus();
        var cache = status.wiredTiger && status.wiredTiger.cache;
        var maximum = cache && cache["maximum bytes configured"];
        if (maximum === null || maximum === undefined || cleanupNumber(maximum) <= 0) {
            throw new Error("MongoDB не сообщила лимит кеша WiredTiger");
        }
        var cacheBytes = cleanupNumber(maximum);
        print("Лимит кеша MongoDB WiredTiger=" + (cacheBytes / 1048576).toFixed(2) + " MiB");
        if (cacheBytes < 1073741824) {
            print("РЕКОМЕНДАЦИЯ: лимит кеша MongoDB меньше 1024 MiB. Проверьте настройку db.mongo.wt.cache_size=1024.");
        }
    } catch (error) {
        print("Проверка лимита кеша MongoDB недоступна: " + cleanupErrorText(error));
    }
    var heapBytes = config.javaHeapBytes;
    if (typeof heapBytes !== "number" || !isFinite(heapBytes) || heapBytes <= 0) {
        print("Лимит Java heap не подтверждён. Проверьте -Xmx в аргументах работающего процесса UniFi.");
        return;
    }
    print("Лимит Java heap=" + (heapBytes / 1048576).toFixed(2) + " MiB");
    if (heapBytes < 4294967296) {
        print("РЕКОМЕНДАЦИЯ: лимит Java heap меньше 4096 MiB. Проверьте настройку unifi.xmx=4096.");
    }
}

function runUniFiCleanup(config) {
    cleanupValidate(config);
    if (config.mode === "index-only") {
        cleanupMaintainIndex(config);
        return "INDEX_OK";
    }
    var jobs = [
        {database: "ace", collection: "user", field: "last_seen"},
        {database: "ace", collection: "reference_name_history", field: "delete_time"},
        {database: "ace", collection: "rogue", field: "last_seen"},
        {database: "ace_stat", collection: "stat_5minutes", field: "datetime"},
        {database: "ace_stat", collection: "stat_hourly", field: "datetime"},
        {database: "ace_stat", collection: "stat_daily", field: "datetime"},
        {database: "ace_stat", collection: "stat_monthly", field: "datetime"},
        {database: "ace_stat", collection: "stat_archive", field: "datetime"},
        {database: "ace_stat", collection: "wifi_connection_event", field: "time"}
    ];
    jobs.forEach(function(job) {
        var days = config.retention[job.collection];
        if (typeof days !== "number" || !isFinite(days) || days < 1 || Math.floor(days) !== days) {
            throw new Error("Неверный срок хранения " + job.collection);
        }
    });
    var started = new Date().getTime();
    var deadline = started + config.maxSeconds * 1000;
    var context = cleanupContext(config);
    var before = cleanupSizes();
    var total = 0;
    var errors = 0;
    var limited = false;
    var perSite = Object.create(null);
    print("UniFi cleanup, режим=" + config.mode + ", начало=" + new Date(started).toISOString());
    cleanupPrintSizes("До", before);
    cleanupResourceReport(config);
    cleanupMaintainIndex(config);
    cleanupPerformanceCheck(config, context);

    function addSite(site, count, collectionName) {
        var name = context.sites[cleanupIdentity(site)] || "(без известного сайта)";
        if (!perSite[name]) {
            perSite[name] = {total: 0, collections: Object.create(null)};
        }
        perSite[name].total += count;
        perSite[name].collections[collectionName] = (perSite[name].collections[collectionName] || 0) + count;
    }

    function budgetExpired() {
        return new Date().getTime() >= deadline;
    }

    for (var jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
        var job = jobs[jobIndex];
        var label = job.database + "." + job.collection;
        var deleted = 0;
        if (budgetExpired() || (config.mode === "apply" && total >= config.maxTotal)) {
            print("Остановлено по общему лимиту перед " + label);
            limited = true;
            break;
        }
        try {
            var collection = db.getSiblingDB(job.database).getCollection(job.collection);
            var cutoff = started - config.retention[job.collection] * 86400000;
            var query = cleanupTimeQuery(job.field, cutoff);
            if (job.collection === "user") {
                query = {$and: [query, cleanupUserQuery(context)]};
            }
            if (config.mode === "dry-run") {
                var candidates = collection.aggregate([
                    {$match: query}, {$group: {_id: "$site_id", count: {$sum: 1}}}
                ], {allowDiskUse: true, maxTimeMS: config.maxTimeMS}).toArray();
                var candidateCount = 0;
                candidates.forEach(function(group) {
                    var count = cleanupNumber(group.count);
                    candidateCount += count;
                    addSite(group._id, count, label);
                });
                print(label + ": кандидатов=" + candidateCount + ", хранение=" +
                      config.retention[job.collection] + " дней, поле=" + job.field);
                total += candidateCount;
                continue;
            }

            while (!budgetExpired() && deleted < config.maxPerCollection && total < config.maxTotal) {
                var limit = Math.min(config.batchSize, config.maxPerCollection - deleted, config.maxTotal - total);
                var batch = collection.find(query, {_id: 1, site_id: 1})
                    .limit(limit).maxTimeMS(config.maxTimeMS).toArray();
                if (batch.length === 0) {
                    break;
                }
                var groups = Object.create(null);
                batch.forEach(function(row) {
                    var present = Object.prototype.hasOwnProperty.call(row, "site_id");
                    var key = present ? typeof row.site_id + ":" + cleanupIdentity(row.site_id) : "missing";
                    if (!groups[key]) {
                        groups[key] = {site: row.site_id, present: present, ids: []};
                    }
                    groups[key].ids.push(row._id);
                });
                var progress = 0;
                Object.keys(groups).forEach(function(key) {
                    var group = groups[key];
                    if (budgetExpired()) {
                        limited = true;
                        return;
                    }
                    var guarded = cleanupBatchQuery(query, group.ids, group.site, group.present);
                    var result = collection.deleteMany(guarded, {
                        writeConcern: {w: 1, wtimeout: config.maxTimeMS}
                    });
                    var count = cleanupNumber(result.deletedCount);
                    if (result.acknowledged === false || count < 0 || count > group.ids.length) {
                        throw new Error("MongoDB не подтвердила корректный результат удаления");
                    }
                    progress += count;
                    deleted += count;
                    total += count;
                    addSite(group.site, count, label);
                });
                if (progress === 0) {
                    print(label + ": остановлено без подтверждённых удалений");
                    limited = true;
                    break;
                }
            }
            if (budgetExpired() || deleted >= config.maxPerCollection || total >= config.maxTotal) {
                limited = true;
            }
            print(label + ": удалено=" + deleted + ", хранение=" +
                  config.retention[job.collection] + " дней, поле=" + job.field);
        } catch (error) {
            errors += 1;
            print("ОШИБКА " + label + ": " + cleanupErrorText(error));
            if (config.mode === "apply") {
                print(label + ": подтверждено удалений до ошибки=" + deleted);
            }
        }
    }

    print(config.mode === "dry-run" ? "Кандидаты по сайтам" : "Подтверждённые удаления по сайтам");
    Object.keys(perSite).sort().forEach(function(name) {
        print("  " + name + ": " + perSite[name].total);
        Object.keys(perSite[name].collections).sort().forEach(function(collectionName) {
            print("    " + collectionName + ": " + perSite[name].collections[collectionName]);
        });
    });
    print((config.mode === "dry-run" ? "Всего кандидатов=" : "Всего удалено=") + total);
    try {
        cleanupPrintSizes("После", cleanupSizes());
    } catch (error) {
        errors += 1;
        print("ОШИБКА размеров после выполнения: " + cleanupErrorText(error));
    }
    print("Продолжительность=" + Math.round((new Date().getTime() - started) / 1000) + " секунд");
    if (errors > 0) {
        return "ERROR";
    }
    if (limited) {
        return "LIMIT";
    }
    return config.mode === "dry-run" ? "DRY_RUN" : "OK";
}

if (typeof cleanupConfig !== "undefined") {
    var cleanupStatus;
    try {
        cleanupStatus = runUniFiCleanup(cleanupConfig);
    } catch (cleanupError) {
        print("ОШИБКА запуска: " + cleanupErrorText(cleanupError));
        cleanupStatus = "ERROR";
    }
    print("__UNIFI_CLEANUP_STATUS__=" + cleanupStatus);
    quit(cleanupStatus === "ERROR" ? 2 : 0);
}

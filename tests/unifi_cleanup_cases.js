/* Run from the repository root with Node or mongo --nodb --norc. All MongoDB calls are fakes. */
var cleanupCaseCount = 0;
var cleanupCaseRealPrint = typeof print === "function" ? print : function(line) {
    if (typeof console !== "undefined") {
        console.log(line);
    }
};
var cleanupConfig;
cleanupConfig = undefined;
var db;
var print;
var quit = function() { throw new Error("Unexpected quit in cleanup tests"); };

if (typeof runUniFiCleanup !== "function") {
    if (typeof require === "function") {
        eval(require("fs").readFileSync(require("path").join(__dirname, "../scripts/unifi-cleanup.js"), "utf8"));
    } else if (typeof load === "function") {
        load("scripts/unifi-cleanup.js");
    } else {
        throw new Error("Load the cleanup engine before the regression cases");
    }
}

function cleanupCaseAssert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function cleanupCaseTest(name, test) {
    try {
        test();
        cleanupCaseCount += 1;
    } catch (error) {
        throw new Error(name + ": " + error.message);
    }
}

function cleanupCaseValue(value) {
    if (value && typeof value.toNumber === "function") {
        return value.toNumber();
    }
    return value instanceof Date ? value.getTime() : value;
}

function cleanupCaseEqual(left, right) {
    if (left instanceof Date || right instanceof Date) {
        return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
    }
    return left === right;
}

function cleanupCaseMatches(document, query) {
    return Object.keys(query).every(function(key) {
        var wanted = query[key];
        if (key === "$and" || key === "$or") {
            var tests = wanted.map(function(part) { return cleanupCaseMatches(document, part); });
            return key === "$and" ? tests.every(Boolean) : tests.some(Boolean);
        }
        var present = Object.prototype.hasOwnProperty.call(document, key);
        var actual = document[key];
        if (wanted === null) {
            return !present || actual === null;
        }
        if (typeof wanted !== "object" || wanted instanceof Date) {
            return cleanupCaseEqual(actual, wanted);
        }
        return Object.keys(wanted).every(function(operator) {
            var value = wanted[operator];
            if (operator === "$exists") { return present === value; }
            if (operator === "$type") {
                return value === "number" ? typeof cleanupCaseValue(actual) === "number" && !(actual instanceof Date) : actual instanceof Date;
            }
            if (operator === "$gte") { return cleanupCaseValue(actual) >= cleanupCaseValue(value); }
            if (operator === "$lt") { return cleanupCaseValue(actual) < cleanupCaseValue(value); }
            if (operator === "$eq") { return cleanupCaseEqual(actual, value); }
            if (operator === "$ne") { return !cleanupCaseEqual(actual, value); }
            if (operator === "$size") { return Array.isArray(actual) && actual.length === value; }
            if (operator === "$in" || operator === "$nin") {
                var found = value.some(function(option) {
                    return option === null && !present || cleanupCaseEqual(actual, option);
                });
                return operator === "$in" ? found : !found;
            }
            throw new Error("Unsupported fake predicate " + operator);
        });
    });
}

function cleanupCaseConfig(mode, overrides) {
    var config = {mode: mode, batchSize: 2, maxPerCollection: 100, maxTotal: 100, javaHeapBytes: 4294967296,
        maxSeconds: 600, maxTimeMS: 5000, retention: {
            user: {years: 1}, reference_name_history: {years: 1}, rogue: {days: 90},
            stat_daily: {years: 1}, stat_monthly: {years: 1}, stat_archive: {years: 1},
            wifi_connection_event: {years: 1}
        }};
    Object.keys(overrides || {}).forEach(function(key) { config[key] = overrides[key]; });
    return config;
}

var cleanupCaseNow = new Date().getTime();
var cleanupCaseOld = cleanupCaseNow - 600 * 86400000;
var cleanupCaseFresh = cleanupCaseNow - 86400000;
function cleanupCaseUser(id, extra) {
    var row = {_id: id, site_id: "s1", usergroup_id: "default", last_seen: cleanupCaseOld};
    Object.keys(extra || {}).forEach(function(key) { row[key] = extra[key]; });
    return row;
}

function cleanupCaseFixture(users) {
    return {
        "ace.site": [{_id: "s1", name: "First"}, {_id: "s2", name: "Second"}],
        "ace.usergroup": [{_id: "default", name: "Default"}],
        "ace.device": [{mac: "managed-device"}],
        "ace.user": users || []
    };
}

function cleanupCaseEnvironment(data, options) {
    options = options || {};
    var state = {data: data, logs: [], deletes: [], builds: [], explains: [], statsCalls: 0, resourceReads: 0};
    state.indexes = options.indexes || [{name: "site_id_1_last_seen_-1", key: {site_id: 1, last_seen: -1}}];
    state.collectionIndexes = {"ace.user": state.indexes};
    function indexesFor(name) {
        if (!state.collectionIndexes[name]) {
            var supplied = options.indexesByCollection && options.indexesByCollection[name];
            state.collectionIndexes[name] = supplied || (name === "ace.reference_name_history" ?
                [{name: "delete_time_1", key: {delete_time: 1}}] :
                [{name: "site_id_1_last_seen_-1", key: {site_id: 1, last_seen: -1}}]);
        }
        return state.collectionIndexes[name];
    }
    function cursor(rows) {
        return {
            limit: function(limit) { rows = rows.slice(0, limit); return this; },
            sort: function() { return this; },
            maxTimeMS: function() { return this; },
            toArray: function() { return rows; },
            forEach: function(callback) { rows.forEach(callback); },
            explain: function() {
                if (options.failExplain) { throw new Error("test query failure"); }
                if (options.explainResult) { return options.explainResult; }
                state.explains.push({returned: rows.length});
                var plan = {stage: "LIMIT", inputStage: {stage: "FETCH", inputStage: {
                    stage: "IXSCAN", indexName: "site_id_1_last_seen_-1"
                }}};
                if (options.slotBasedPlan) { plan = {queryPlan: plan, slotBasedPlan: {stages: "fake"}}; }
                return {queryPlanner: {winningPlan: plan}, executionStats: {executionTimeMillis: 1, nReturned: rows.length,
                    totalDocsExamined: rows.length, totalKeysExamined: rows.length}};
            }
        };
    }
    function collection(name) {
        if ((options.forbiddenCollections || []).indexOf(name) >= 0) {
            throw new Error("Unexpected access to " + name);
        }
        if (!data[name]) { data[name] = []; }
        return {
            find: function(query, projection) {
                if (options.onlyIndexes) { throw new Error("Unexpected data read during index-only"); }
                var rows = data[name].filter(function(row) { return cleanupCaseMatches(row, query); });
                if (projection) {
                    rows = rows.map(function(row) {
                        var selected = {};
                        Object.keys(projection).forEach(function(key) {
                            if (projection[key] && Object.prototype.hasOwnProperty.call(row, key)) { selected[key] = row[key]; }
                        });
                        return selected;
                    });
                }
                return cursor(rows);
            },
            aggregate: function(stages) {
                if (options.onlyIndexes) { throw new Error("Unexpected aggregate during index-only"); }
                var groups = [];
                data[name].forEach(function(row) {
                    if (!cleanupCaseMatches(row, stages[0].$match)) { return; }
                    var site = row.site_id === undefined ? null : row.site_id;
                    var group = groups.filter(function(item) { return item._id === site; })[0];
                    if (!group) { group = {_id: site, count: 0}; groups.push(group); }
                    group.count += 1;
                });
                return cursor(groups);
            },
            deleteMany: function(query) {
                state.deletes.push({collection: name, query: query});
                if (options.beforeDelete) { options.beforeDelete(state, name); }
                var removed = data[name].filter(function(row) { return cleanupCaseMatches(row, query); });
                data[name] = data[name].filter(function(row) { return !cleanupCaseMatches(row, query); });
                return {deletedCount: removed.length, acknowledged: true};
            },
            getIndexes: function() { return indexesFor(name); },
            createIndex: function(key, settings) {
                state.builds.push({collection: name, key: key, settings: settings});
                if (!options.missingIndexReadback) {
                    indexesFor(name).push(options.createdIndex || {name: settings.name, key: key});
                }
                if (Object.prototype.hasOwnProperty.call(options, "createResult")) { return options.createResult; }
                return options.modernIndexNames ? settings.name : {ok: 1};
            }
        };
    }
    db = {getSiblingDB: function(name) {
        return {
            getCollectionNames: function() {
                return Object.keys(data).filter(function(key) { return key.indexOf(name + ".") === 0; })
                    .map(function(key) { return key.slice(name.length + 1); });
            },
            site: collection(name + ".site"), usergroup: collection(name + ".usergroup"),
            device: collection(name + ".device"), getCollection: function(coll) { return collection(name + "." + coll); },
            serverStatus: function() {
                state.resourceReads += 1;
                if (options.onlyIndexes) { throw new Error("Unexpected resource read during index-only"); }
                if (options.failServerStatus) { throw new Error("test serverStatus unavailable"); }
                return options.serverStatusResult || {wiredTiger: {cache: {
                    "maximum bytes configured": options.cacheMaxBytes === undefined ? 1073741824 : options.cacheMaxBytes,
                    "bytes currently in the cache": options.cacheUsedBytes === undefined ? 104857600 : options.cacheUsedBytes
                }}};
            },
            stats: function() {
                if (options.onlyIndexes) { throw new Error("Unexpected collection stats during index-only"); }
                state.statsCalls += 1;
                if (options.failAfterStats && state.statsCalls > 2) { throw new Error("stats failed"); }
                return {ok: 1, dataSize: 10, storageSize: 12, indexSize: 3};
            }
        };
    }};
    print = function(line) { state.logs.push(String(line)); };
    return state;
}

cleanupCaseTest("year retention uses 365 days per year", function() {
    var now = new Date("2026-11-06T12:34:56.789Z").getTime();
    cleanupCaseAssert(cleanupRetentionCutoff(now, {years: 3}) === now - 1095 * 86400000,
        "three years did not use 1095 days");
    cleanupCaseAssert(cleanupRetentionCutoff(now, {years: 1}) === now - 365 * 86400000,
        "one year did not use 365 days");
});

cleanupCaseTest("retention cutoff keeps the boundary in every supported time representation", function() {
    var cutoff = cleanupRetentionCutoff(new Date("2026-11-06T12:00:00.000Z").getTime(), {years: 3});
    var query = cleanupTimeQuery("time", cutoff);
    [
        [cutoff - 1, cutoff, cutoff + 1],
        [Math.floor(cutoff / 1000) - 1, Math.floor(cutoff / 1000), Math.floor(cutoff / 1000) + 1],
        [new Date(cutoff - 1), new Date(cutoff), new Date(cutoff + 1)]
    ].forEach(function(values) {
        cleanupCaseAssert(cleanupCaseMatches({time: values[0]}, query), "expired record was retained");
        cleanupCaseAssert(!cleanupCaseMatches({time: values[1]}, query), "boundary record was removed");
        cleanupCaseAssert(!cleanupCaseMatches({time: values[2]}, query), "recent record was removed");
    });
});

cleanupCaseTest("three-year cleanup uses a 1095-day window", function() {
    var config = cleanupCaseConfig("apply");
    config.retention.user = {years: 3};
    var cutoff = cleanupRetentionCutoff(cleanupCaseNow, {years: 3});
    var state = cleanupCaseEnvironment(cleanupCaseFixture([
        cleanupCaseUser(1, {last_seen: cutoff - 86400000}),
        cleanupCaseUser(2, {last_seen: cleanupCaseNow - 1001 * 86400000})
    ]));
    cleanupCaseAssert(runUniFiCleanup(config) === "OK", "three-year cleanup failed");
    cleanupCaseAssert(state.data["ace.user"].length === 1 && state.data["ace.user"][0]._id === 2,
        "three-year retention used a shorter day interval");
    cleanupCaseAssert(state.logs.some(function(line) {
        return line.indexOf("ace.user: удалено=1, хранение=3 года,") === 0;
    }), "report did not use years");
});

[3, {years: 0}, {years: 3, days: 1095}, {months: 36}, {years: 11}, {days: 3651}].forEach(function(policy, number) {
    cleanupCaseTest("invalid retention policy " + number + " prevents data access", function() {
        var config = cleanupCaseConfig("apply");
        config.retention.user = policy;
        var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {onlyIndexes: true});
        var failed = false;
        try { runUniFiCleanup(config); } catch (error) {
            failed = error.message.indexOf("Неверный срок хранения user") === 0;
        }
        cleanupCaseAssert(failed && state.deletes.length === 0 && state.statsCalls === 0,
            "invalid policy reached database operations");
    });
});

cleanupCaseTest("rogue retention uses days", function() {
    var config = cleanupCaseConfig("apply");
    config.retention.rogue = {years: 3};
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {onlyIndexes: true});
    var failed = false;
    try { runUniFiCleanup(config); } catch (error) {
        failed = error.message.indexOf("Неверный срок хранения rogue") === 0;
    }
    cleanupCaseAssert(failed && state.statsCalls === 0, "rogue accepted an unexpected retention unit");
});

cleanupCaseTest("explicit historical day retention remains supported", function() {
    var config = cleanupCaseConfig("apply");
    config.retention.user = {days: 730};
    var state = cleanupCaseEnvironment(cleanupCaseFixture([
        cleanupCaseUser(1, {last_seen: cleanupCaseNow - 731 * 86400000}), cleanupCaseUser(2)
    ]));
    cleanupCaseAssert(runUniFiCleanup(config) === "OK", "custom day retention failed");
    cleanupCaseAssert(state.data["ace.user"].length === 1 && state.data["ace.user"][0]._id === 2,
        "custom day interval changed");
});

["dry-run", "apply", "index-only"].forEach(function(mode) {
    cleanupCaseTest("short statistics remain untouched in " + mode + " with legacy overrides", function() {
        var data = cleanupCaseFixture();
        var excluded = ["ace_stat.stat_5minutes", "ace_stat.stat_hourly"];
        excluded.forEach(function(name) {
            data[name] = [{_id: name, site_id: "s1", datetime: new Date(cleanupCaseOld), time: cleanupCaseOld}];
        });
        var state = cleanupCaseEnvironment(data, {forbiddenCollections: excluded});
        var config = cleanupCaseConfig(mode);
        config.retention.stat_5minutes = 1;
        config.retention.stat_hourly = 1;
        var expected = mode === "dry-run" ? "DRY_RUN" : mode === "apply" ? "OK" : "INDEX_OK";
        cleanupCaseAssert(runUniFiCleanup(config) === expected, "excluded collection was accessed");
        excluded.forEach(function(name) {
            cleanupCaseAssert(state.data[name].length === 1, "short statistics record was removed");
            cleanupCaseAssert(!state.logs.some(function(line) { return line.indexOf(name) >= 0; }),
                "excluded collection appeared in cleanup report");
        });
    });
});

cleanupCaseTest("mixed time units and non-time sentinels", function() {
    var rows = [cleanupCaseUser(1, {last_seen: Math.floor(cleanupCaseOld / 1000)}),
        cleanupCaseUser(2), cleanupCaseUser(3, {last_seen: new Date(cleanupCaseOld)}),
        cleanupCaseUser(4, {last_seen: Math.floor(cleanupCaseFresh / 1000)}),
        cleanupCaseUser(5, {last_seen: cleanupCaseFresh}), cleanupCaseUser(6, {last_seen: new Date(cleanupCaseFresh)}),
        cleanupCaseUser(7, {last_seen: 0}), cleanupCaseUser(8, {last_seen: null}),
        cleanupCaseUser(9, {last_seen: String(cleanupCaseOld)})];
    var state = cleanupCaseEnvironment(cleanupCaseFixture(rows));
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply")) === "OK", "unexpected status");
    cleanupCaseAssert(state.data["ace.user"].length === 6, "fresh, sentinel or string time removed");
    cleanupCaseAssert(state.logs.indexOf("Всего удалено=3") >= 0, "wrong actual count");
});

cleanupCaseTest("BSON numeric wrappers use numeric ranges", function() {
    function NumericLong(value) { this.value = value; }
    NumericLong.prototype.toNumber = function() { return this.value; };
    var state = cleanupCaseEnvironment(cleanupCaseFixture([
        cleanupCaseUser(1, {last_seen: new NumericLong(Math.floor(cleanupCaseOld / 1000))}),
        cleanupCaseUser(2, {last_seen: new NumericLong(cleanupCaseOld)}),
        cleanupCaseUser(3, {last_seen: new NumericLong(Math.floor(cleanupCaseFresh / 1000))})
    ]));
    runUniFiCleanup(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.data["ace.user"].length === 1 && state.data["ace.user"][0]._id === 3, "BSON numeric time mismatch");
    cleanupCaseAssert(cleanupNumber(new NumericLong(12)) === 12, "BSON metric conversion failed");
});

cleanupCaseTest("dry run does not write", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]));
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("dry-run")) === "DRY_RUN", "dry-run failed");
    cleanupCaseAssert(state.deletes.length === 0 && state.builds.length === 0, "dry-run wrote");
    cleanupCaseAssert(state.logs.indexOf("Всего кандидатов=1") >= 0, "preview lost candidate");
});

cleanupCaseTest("performance checkpoint is bounded for every site", function() {
    var users = [];
    for (var number = 0; number < 150; number += 1) { users.push(cleanupCaseUser(number)); }
    var state = cleanupCaseEnvironment(cleanupCaseFixture(users));
    runUniFiCleanup(cleanupCaseConfig("dry-run"));
    cleanupCaseAssert(state.explains.length === 2, "not all sites checked");
    cleanupCaseAssert(state.explains[0].returned === 100 && state.explains[1].returned === 0, "checkpoint not bounded");
    cleanupCaseAssert(state.logs.some(function(line) {
        return line.indexOf("Проверка ace.user, сайт=First") === 0 && line.indexOf("индекс=site_id_1_last_seen_-1") > 0;
    }), "checkpoint omitted index");
});

cleanupCaseTest("failed performance checkpoint prevents cleanup", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {failExplain: true});
    var failed = false;
    try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
    cleanupCaseAssert(failed && state.deletes.length === 0, "cleanup proceeded after failed query");
});

cleanupCaseTest("modern slot-based explain reports the index", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {slotBasedPlan: true});
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("dry-run")) === "DRY_RUN", "modern plan rejected");
    cleanupCaseAssert(state.logs.some(function(line) {
        return line.indexOf("Проверка ace.user, сайт=First") === 0 && line.indexOf("индекс=site_id_1_last_seen_-1") > 0;
    }), "modern queryPlan index omitted");
});

cleanupCaseTest("low resource limits are reported without blocking cleanup", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {cacheMaxBytes: 536870912});
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply", {javaHeapBytes: 2147483648})) === "OK", "resource advice failed cleanup");
    cleanupCaseAssert(state.logs.some(function(line) { return line.indexOf("db.mongo.wt.cache_size=1024") >= 0; }), "cache recommendation missing");
    cleanupCaseAssert(state.logs.some(function(line) { return line.indexOf("unifi.xmx=4096") >= 0; }), "heap recommendation missing");
    cleanupCaseAssert(state.builds.length === 0 && state.deletes.length === 0, "resource check changed data");
});

[1073741824, 2147483648].forEach(function(cacheBytes) {
    cleanupCaseTest("adequate cache limit " + cacheBytes + " is reported", function() {
        var state = cleanupCaseEnvironment(cleanupCaseFixture(), {cacheMaxBytes: cacheBytes, cacheUsedBytes: 1048576});
        cleanupResourceReport(cleanupCaseConfig("dry-run"));
        cleanupCaseAssert(state.logs.some(function(line) { return line.indexOf("Лимит кеша MongoDB WiredTiger=") === 0; }), "cache limit not reported");
        cleanupCaseAssert(state.logs.some(function(line) { return line === "Лимит Java heap=4096.00 MiB"; }), "heap limit not reported");
        cleanupCaseAssert(!state.logs.some(function(line) { return line.indexOf("РЕКОМЕНДАЦИЯ:") === 0; }), "adequate limit warned");
    });
});

cleanupCaseTest("cache maximum governs advice rather than current usage", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {cacheMaxBytes: 268435456, cacheUsedBytes: 1073741824});
    cleanupResourceReport(cleanupCaseConfig("dry-run"));
    cleanupCaseAssert(state.logs.some(function(line) { return line.indexOf("db.mongo.wt.cache_size=1024") >= 0; }), "used cache replaced maximum");
});

[null, undefined].forEach(function(heap) {
    cleanupCaseTest("unknown Java heap " + heap + " is not guessed", function() {
        var state = cleanupCaseEnvironment(cleanupCaseFixture());
        cleanupResourceReport(cleanupCaseConfig("dry-run", {javaHeapBytes: heap}));
        cleanupCaseAssert(state.logs.some(function(line) { return line.indexOf("Лимит Java heap не подтверждён.") === 0; }), "unknown heap not reported");
        cleanupCaseAssert(!state.logs.some(function(line) { return line.indexOf("unifi.xmx=4096") >= 0; }), "unknown heap was guessed");
    });
});

cleanupCaseTest("unavailable cache check leaves cleanup operational", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {failServerStatus: true});
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply")) === "OK", "resource read failed cleanup");
    cleanupCaseAssert(state.logs.some(function(line) { return line.indexOf("Проверка лимита кеша MongoDB недоступна:") === 0; }), "missing unavailable check message");
});

[{ok: 0}, {queryPlanner: {winningPlan: {stage: "IXSCAN"}}, executionStats: {
    executionSuccess: false, executionTimeMillis: 1, nReturned: 0, totalDocsExamined: 0, totalKeysExamined: 0
}}].forEach(function(result, number) {
    cleanupCaseTest("failed explain envelope " + number + " prevents cleanup", function() {
        var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {explainResult: result});
        var failed = false;
        try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
        cleanupCaseAssert(failed && state.deletes.length === 0, "failed envelope allowed deletion");
        cleanupCaseAssert(!state.logs.some(function(line) {
            return line.indexOf("Проверка ace.user,") === 0;
        }), "failed explain was reported as a checkpoint");
    });
});

cleanupCaseTest("manual client settings are protected", function() {
    var protectedSettings = [{name: ""}, {note: ""}, {fixed_ip: "test"}, {blocked: true},
        {use_fixedip: true}, {fixed_ap_enabled: true}, {noted: true}, {fixed_ap_mac: "configured"},
        {fingerprint_override: {}}, {last_1x_identities: ["identity"]}, {virtual_network_override_enabled: true},
        {virtual_network_override_id: "configured"}, {network_id: "configured"}, {vlan: 20},
        {usergroup_id: "custom"}, {mac: "managed-device"}];
    var users = protectedSettings.map(function(settings, index) { return cleanupCaseUser(index, settings); });
    var state = cleanupCaseEnvironment(cleanupCaseFixture(users));
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply")) === "OK", "protected run failed");
    cleanupCaseAssert(state.data["ace.user"].length === users.length, "configured client removed");
});

cleanupCaseTest("normal membership metadata and default groups remain eligible", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([
        cleanupCaseUser(1, {network_members_group_ids: ["ordinary-metadata"], last_1x_identities: []})
    ]));
    runUniFiCleanup(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.data["ace.user"].length === 0, "ordinary metadata prevented cleanup");
});

cleanupCaseTest("unknown default group is retained", function() {
    var data = cleanupCaseFixture([cleanupCaseUser(1)]);
    data["ace.usergroup"] = [];
    var state = cleanupCaseEnvironment(data);
    runUniFiCleanup(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.data["ace.user"].length === 1, "unknown group was deleted");
});

["timestamp", "configuration", "site"].forEach(function(kind) {
    cleanupCaseTest("concurrent " + kind + " is rechecked", function() {
        var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {beforeDelete: function(current) {
            var row = current.data["ace.user"][0];
            if (kind === "timestamp") { row.last_seen = cleanupCaseFresh; }
            if (kind === "configuration") { row.virtual_network_override_enabled = true; }
            if (kind === "site") { row.site_id = "s2"; }
        }});
        cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply")) === "LIMIT", "no-progress status lost");
        cleanupCaseAssert(state.data["ace.user"].length === 1, "concurrent change ignored");
        cleanupCaseAssert(state.logs.indexOf("Всего удалено=0") >= 0, "unconfirmed deletion counted");
    });
});

cleanupCaseTest("bounded ids and global limit", function() {
    var users = [cleanupCaseUser(1, {mac: "same"}), cleanupCaseUser(2, {mac: "same", site_id: "s2"}),
        cleanupCaseUser(3), cleanupCaseUser(4), cleanupCaseUser(5)];
    var state = cleanupCaseEnvironment(cleanupCaseFixture(users));
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply", {maxTotal: 3})) === "LIMIT", "global cap ignored");
    cleanupCaseAssert(state.data["ace.user"].length === 2, "wrong number removed");
    cleanupCaseAssert(state.logs.indexOf("  First: 2") >= 0 && state.logs.indexOf("  Second: 1") >= 0, "site totals include undeleted rows");
    state.deletes.forEach(function(call) {
        cleanupCaseAssert(call.query.$and[1]._id.$in.length <= 2, "unbounded delete");
        cleanupCaseAssert(call.query.$and.length === 3, "site or age guard missing");
    });
});

cleanupCaseTest("collection limit", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1), cleanupCaseUser(2)]));
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply", {maxPerCollection: 1})) === "LIMIT", "collection cap ignored");
    cleanupCaseAssert(state.data["ace.user"].length === 1, "collection over-deleted");
});

cleanupCaseTest("partial failure reports actual deletions", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1), cleanupCaseUser(2)]), {
        beforeDelete: function(current) { if (current.deletes.length === 2) { throw new Error("test delete failure"); } }
    });
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply", {batchSize: 1})) === "ERROR", "failure returned success");
    cleanupCaseAssert(state.data["ace.user"].length === 1, "partial delete result wrong");
    cleanupCaseAssert(state.logs.indexOf("Всего удалено=1") >= 0, "partial deletion lost");
    cleanupCaseAssert(state.logs.indexOf("ace.user: подтверждено удалений до ошибки=1") >= 0, "partial collection count lost");
});

cleanupCaseTest("post-cleanup stats failure is visible", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {failAfterStats: true});
    cleanupCaseAssert(runUniFiCleanup(cleanupCaseConfig("apply")) === "ERROR", "stats error hidden");
    cleanupCaseAssert(state.logs.indexOf("Всего удалено=1") >= 0, "successful deletion lost");
});

cleanupCaseTest("statistics use indexed BSON dates", function() {
    var data = cleanupCaseFixture();
    data["ace_stat.stat_daily"] = [{_id: 1, site_id: "s1", datetime: new Date(cleanupCaseOld), time: cleanupCaseFresh},
        {_id: 2, site_id: "s1", datetime: new Date(cleanupCaseFresh), time: cleanupCaseOld}];
    var state = cleanupCaseEnvironment(data);
    runUniFiCleanup(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.data["ace_stat.stat_daily"].length === 1 &&
        state.data["ace_stat.stat_daily"][0]._id === 2, "wrong statistics time field");
});

cleanupCaseTest("missing index preview and idempotent creation", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {indexes: [{name: "_id_", key: {_id: 1}}]});
    cleanupMaintainIndex(cleanupCaseConfig("dry-run"));
    cleanupCaseAssert(state.builds.length === 0, "preview built index");
    cleanupMaintainIndex(cleanupCaseConfig("apply"));
    cleanupMaintainIndex(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.builds.length === 1 && state.builds[0].settings.background === true, "index rebuilt or foreground");
});

cleanupCaseTest("equivalent index under another name is reused", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {indexes: [{name: "custom", key: {site_id: 1, last_seen: -1}}]});
    cleanupMaintainIndex(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.builds.length === 0, "equivalent index duplicated");
});

cleanupCaseTest("mongosh string acknowledgement requires index readback", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {
        indexes: [{name: "_id_", key: {_id: 1}}], createResult: "site_id_1_last_seen_-1"
    });
    cleanupMaintainIndex(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.builds.length === 1, "mongosh acknowledgement rejected");
    cleanupMaintainIndex(cleanupCaseConfig("apply"));
    cleanupCaseAssert(state.builds.length === 1, "mongosh-created index rebuilt");
});

cleanupCaseTest("index-only restores the index without cleanup or resource reads", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {
        indexes: [{name: "_id_", key: {_id: 1}}], onlyIndexes: true
    });
    cleanupCaseAssert(runUniFiCleanup({mode: "index-only"}) === "INDEX_OK", "index-only failed");
    cleanupCaseAssert(runUniFiCleanup({mode: "index-only"}) === "INDEX_OK", "index-only repeat failed");
    cleanupCaseAssert(state.builds.length === 1, "index-only did not restore idempotently");
    cleanupCaseAssert(state.deletes.length === 0 && state.data["ace.user"].length === 1, "index-only deleted data");
    cleanupCaseAssert(state.statsCalls === 0 && state.resourceReads === 0 && state.explains.length === 0, "index-only checked resources or data");
});

[false, true].forEach(function(modern) {
    cleanupCaseTest("index-only restores all three measured indexes, modern=" + modern, function() {
        var data = cleanupCaseFixture([cleanupCaseUser(1)]);
        data["ace.rogue"] = [];
        data["ace.reference_name_history"] = [];
        var state = cleanupCaseEnvironment(data, {
            indexes: [{name: "_id_", key: {_id: 1}}], modernIndexNames: modern, onlyIndexes: true,
            indexesByCollection: {
                "ace.rogue": [{name: "_id_", key: {_id: 1}}],
                "ace.reference_name_history": [{name: "_id_", key: {_id: 1}}]
            }
        });
        cleanupCaseAssert(runUniFiCleanup({mode: "index-only"}) === "INDEX_OK", "registry restore failed");
        cleanupCaseAssert(runUniFiCleanup({mode: "index-only"}) === "INDEX_OK", "registry repeat failed");
        cleanupCaseAssert(state.builds.length === 3, "registry missing or rebuilt indexes");
        cleanupCaseAssert(state.builds.some(function(build) {
            return build.collection === "ace.reference_name_history" && build.key.delete_time === 1 &&
                build.settings.name === "delete_time_1" && build.settings.expireAfterSeconds === undefined;
        }), "reference index was not ordinary non-TTL");
        cleanupCaseAssert(state.deletes.length === 0 && state.statsCalls === 0 && state.resourceReads === 0, "registry restore cleaned data");
    });
});

cleanupCaseTest("absent optional collections are not created for indexes", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture(), {onlyIndexes: true});
    cleanupCaseAssert(runUniFiCleanup({mode: "index-only"}) === "INDEX_OK", "optional collection prevented startup");
    cleanupCaseAssert(!Object.prototype.hasOwnProperty.call(state.data, "ace.rogue") &&
        !Object.prototype.hasOwnProperty.call(state.data, "ace.reference_name_history"), "optional collection created");
    cleanupCaseAssert(state.builds.length === 0, "optional absent collection indexed");
});

cleanupCaseTest("missing user collection requires UniFi initialization", function() {
    var data = cleanupCaseFixture();
    delete data["ace.user"];
    var state = cleanupCaseEnvironment(data, {onlyIndexes: true});
    var failed = false;
    try { runUniFiCleanup({mode: "index-only"}); } catch (error) { failed = true; }
    cleanupCaseAssert(failed && state.builds.length === 0, "missing user collection initialized blindly");
    cleanupCaseAssert(!Object.prototype.hasOwnProperty.call(data, "ace.user"), "user collection created");
});

cleanupCaseTest("reference TTL index is rejected before cleanup", function() {
    var data = cleanupCaseFixture([cleanupCaseUser(1)]);
    data["ace.reference_name_history"] = [];
    var state = cleanupCaseEnvironment(data, {indexesByCollection: {
        "ace.reference_name_history": [{name: "delete_time_1", key: {delete_time: 1}, expireAfterSeconds: 0}]
    }});
    var failed = false;
    try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
    cleanupCaseAssert(failed && state.deletes.length === 0 && state.builds.length === 0, "TTL index accepted or replaced");
});

[{ok: 1}, "site_id_1_last_seen_-1"].forEach(function(acknowledgement, number) {
    cleanupCaseTest("missing index readback " + number + " prevents cleanup", function() {
        var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {
            indexes: [{name: "_id_", key: {_id: 1}}], createResult: acknowledgement, missingIndexReadback: true
        });
        var failed = false;
        try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
        cleanupCaseAssert(failed && state.deletes.length === 0, "unconfirmed index allowed deletion");
    });
});

[{ok: 0}, null].forEach(function(acknowledgement, number) {
    cleanupCaseTest("failed index acknowledgement " + number + " prevents cleanup", function() {
        var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {
            indexes: [{name: "_id_", key: {_id: 1}}], createResult: acknowledgement
        });
        var failed = false;
        try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
        cleanupCaseAssert(failed && state.deletes.length === 0, "failed acknowledgement allowed deletion");
    });
});

cleanupCaseTest("wrong index readback shape prevents cleanup", function() {
    var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {
        indexes: [{name: "_id_", key: {_id: 1}}],
        createdIndex: {name: "site_id_1_last_seen_-1", key: {site_id: 1, last_seen: -1}, sparse: true}
    });
    var failed = false;
    try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
    cleanupCaseAssert(failed && state.deletes.length === 0, "wrong shape allowed deletion");
});

[{key: {site_id: 1, last_seen: 1}}, {key: {site_id: 1, last_seen: -1}, sparse: true},
 {key: {site_id: 1, last_seen: -1}, partialFilterExpression: {x: 1}},
 {key: {site_id: 1, last_seen: -1}, collation: {locale: "en"}}].forEach(function(index, number) {
    cleanupCaseTest("index conflict " + number + " stops before deletion", function() {
        index.name = "site_id_1_last_seen_-1";
        var state = cleanupCaseEnvironment(cleanupCaseFixture([cleanupCaseUser(1)]), {indexes: [index]});
        var failed = false;
        try { runUniFiCleanup(cleanupCaseConfig("apply")); } catch (error) { failed = true; }
        cleanupCaseAssert(failed && state.deletes.length === 0 && state.builds.length === 0, "conflicting index accepted");
    });
});

cleanupCaseRealPrint("UniFi cleanup regression cases passed: " + cleanupCaseCount);

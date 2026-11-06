#!/usr/bin/env python3
"""Raise verified UniFi memory limits with a backup and checked service restart."""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import ssl
import stat
import subprocess
import tempfile
import time
import urllib.request

MIB = 1024 ** 2
MIN_CACHE = 1024 * MIB
MIN_HEAP = 4096 * MIB
OS_RESERVE = 1536 * MIB
PROPERTIES_PATHS = ("/var/lib/unifi/system.properties", "/usr/lib/unifi/data/system.properties",
                    "/opt/unifi/data/system.properties")
PROPERTY_LINE = re.compile(r"^\s*([^#!\s:=]+)(?:\s*[:=]\s*|\s+|$)(.*)$")


class TuneError(Exception):
    pass


def parse_heap_flags(arguments):
    """The last explicit JVM heap flag takes precedence."""
    size = None
    for argument in arguments:
        match = re.fullmatch(r"(?:-Xmx|-XX:MaxHeapSize=)([0-9]+)([kKmMgG]?)", argument)
        if match:
            multiplier = {"": 1, "k": 1024, "m": MIB, "g": 1024 ** 3}[match[2].lower()]
            value = int(match[1]) * multiplier
            if value > 0:
                size = value
    return size


def read_java_heap():
    try:
        pid = int(subprocess.check_output(
            ["systemctl", "show", "unifi", "-p", "MainPID", "--value"],
            timeout=5, stderr=subprocess.DEVNULL, text=True).strip())
        if pid <= 0:
            return None
        raw = Path("/proc/{}/cmdline".format(pid)).read_bytes()
        return parse_heap_flags([part.decode("utf-8", errors="replace") for part in raw.split(b"\0") if part])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def read_mongo_cache(shell, host, port):
    script = ("var s=db.serverStatus(); var c=s.wiredTiger&&s.wiredTiger.cache;"
              "var v=c&&c['maximum bytes configured'];"
              "if(v&&typeof v.toNumber==='function'){v=v.toNumber();}"
              "print(JSON.stringify({cacheBytes:typeof v==='number'?v:null}));")
    try:
        result = subprocess.run([shell, "--norc", "--quiet", "--host", host, "--port", str(port),
                                 "admin", "--eval", script],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                timeout=15, check=True)
        # Both shells may print startup notices before the JSON payload.
        for line in reversed(result.stdout.splitlines()):
            try:
                value = json.loads(line).get("cacheBytes")
            except (ValueError, AttributeError):
                continue
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
                return int(value)
            return None
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def read_mem_total():
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) * 1024
    raise TuneError("Не удалось определить объём RAM")


def status_ready(url):
    # The controller normally presents a self-signed certificate on loopback.
    context = ssl._create_unverified_context()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPSHandler(context=context))
    try:
        with opener.open(url, timeout=3) as response:
            data = json.loads(response.read(1024 * 1024))
        meta = data.get("meta", {})
        return meta.get("rc") == "ok" and meta.get("up") is True
    except (OSError, ValueError, AttributeError):
        return False


def restart_service():
    subprocess.run(["systemctl", "restart", "unifi"], check=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)


def wait_for_runtime(shell, host, port, status_url, cache_target=None, heap_target=None,
                     wait_seconds=120):
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if status_ready(status_url):
            cache = read_mongo_cache(shell, host, port)
            heap = read_java_heap()
            if cache is not None and heap is not None:
                if cache_target is not None and cache < cache_target:
                    raise TuneError("После перезапуска кеш MongoDB ниже заданного значения")
                if heap_target is not None and heap < heap_target:
                    raise TuneError("После перезапуска Java heap ниже заданного значения")
                return cache, heap
        time.sleep(2)
    raise TuneError("UniFi и MongoDB не подтвердили готовность за отведённое время")


def wait_initial_ready(shell, host, port, status_url, wait_seconds=60):
    """Do not race the controller's startup schema/index maintenance."""
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if status_ready(status_url):
            cache = read_mongo_cache(shell, host, port)
            if cache is not None:
                return cache
        time.sleep(2)
    raise TuneError("Перед обслуживанием UniFi и MongoDB не подтвердили готовность")


def properties_path(explicit=None):
    candidates = [explicit] if explicit else PROPERTIES_PATHS
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file():
            return path.resolve(strict=True)
    # A new initialized controller may not have created this optional file yet.
    # Only use an existing data directory after API and Mongo readiness checks.
    for candidate in candidates:
        path = Path(candidate).resolve()
        if path.parent.is_dir() and not path.exists():
            return path
    raise TuneError("Не найден system.properties. Укажите его путь через --properties")


def property_values(text):
    values = {}
    for line in text.splitlines():
        match = PROPERTY_LINE.match(line)
        if match:
            values[match[1]] = match[2].strip()
    return values


def property_mib(values, key):
    raw = values.get(key, "")
    return int(raw) * MIB if re.fullmatch(r"[0-9]+", raw) else 0


def tuning_changes(values, cache, heap):
    changes = {}
    configured_cache = property_mib(values, "db.mongo.wt.cache_size")
    configured_heap = property_mib(values, "unifi.xmx")
    automatic_cache = values.get("db.mongo.wt.cache_size_default", "false").lower() == "true"
    target_cache = max(MIN_CACHE, cache, 0 if automatic_cache else configured_cache)
    target_heap = max(MIN_HEAP, heap, configured_heap, property_mib(values, "unifi.xms"))
    if cache < MIN_CACHE or (not automatic_cache and configured_cache < cache):
        changes["db.mongo.wt.cache_size"] = str((target_cache + MIB - 1) // MIB)
    if cache < MIN_CACHE:
        changes["db.mongo.wt.cache_size_default"] = "false"
    # Changing either resource restarts the service. Keep the other resource from
    # falling below its observed runtime value if the file has older settings.
    if heap < MIN_HEAP or configured_heap < heap:
        changes["unifi.xmx"] = str((target_heap + MIB - 1) // MIB)
    return changes, target_cache, target_heap


def updated_properties(text, changes):
    lines = []
    for line in text.splitlines():
        match = PROPERTY_LINE.match(line)
        if not match or match[1] not in changes:
            lines.append(line)
    lines.extend(key + "=" + value for key, value in changes.items())
    return "\n".join(lines) + "\n"


def atomic_properties(path, text):
    existed = path.exists()
    metadata = path.stat() if existed else path.parent.stat()
    descriptor, temporary = tempfile.mkstemp(prefix=".system.properties-", dir=str(path.parent))
    try:
        os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode) if existed else 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = None
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)


def tune(shell, host, port, explicit_properties, status_url, apply=False,
         backup_root=Path("/var/backups/unifi-cleanup")):
    cache = wait_initial_ready(shell, host, port, status_url)
    heap = read_java_heap()
    if cache is None or heap is None:
        print("Автонастройка ресурсов пропущена. Фактический кеш или Java heap не удалось проверить.")
        return 0
    print("Ресурсы до проверки: кеш MongoDB={} MiB, Java heap={} MiB".format(cache // MIB, heap // MIB))
    if cache >= MIN_CACHE and heap >= MIN_HEAP:
        print("Память соответствует заданным минимумам, перезапуск не требуется.")
        return 0
    path = properties_path(explicit_properties)
    existed = path.exists()
    original = path.read_text(encoding="utf-8") if existed else ""
    changes, target_cache, target_heap = tuning_changes(property_values(original), cache, heap)
    memory = read_mem_total()
    needed = target_cache + target_heap + OS_RESERVE
    if memory < needed:
        print("Автонастройка ресурсов пропущена. RAM={} MiB, требуется минимум {} MiB "
              "для заданных лимитов и системы. Увеличьте RAM.".format(memory // MIB, needed // MIB))
        return 0
    print("План настроек: " + ", ".join(key + "=" + value for key, value in changes.items()))
    if not apply:
        print("Предварительный просмотр, конфигурация не изменяется.")
        return 0
    if os.geteuid() != 0:
        raise TuneError("Автонастройка с перезапуском требует root")
    backup_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    backup = backup_root / ("tuning-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    backup.mkdir(mode=0o700)
    backup_reference = backup / ("system.properties" if existed else "system.properties.absent")
    if existed:
        shutil.copy2(str(path), str(backup_reference))
    else:
        backup_reference.write_text("system.properties did not exist before tuning.\n", encoding="utf-8")
    os.chmod(str(backup_reference), 0o600)
    print("Резервная копия конфигурации: " + str(backup_reference))
    written = False
    try:
        atomic_properties(path, updated_properties(original, changes))
        written = True
        print("Применение лимитов и перезапуск UniFi.")
        restart_service()
        actual_cache, actual_heap = wait_for_runtime(shell, host, port, status_url, target_cache, target_heap)
        print("Проверка после перезапуска: кеш MongoDB={} MiB, Java heap={} MiB".format(
            actual_cache // MIB, actual_heap // MIB))
        return 0
    except Exception as error:
        print("ОШИБКА применения настройки ресурсов: " + str(error))
        if written:
            try:
                if existed:
                    atomic_properties(path, original)
                else:
                    path.unlink()
                restart_service()
                wait_for_runtime(shell, host, port, status_url)
                print("Предыдущая конфигурация восстановлена, готовность UniFi проверена.")
            except Exception as rollback_error:
                print("ОШИБКА восстановления. Используйте резервную копию {}. Причина: {}".format(
                    backup_reference, rollback_error))
        return 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    parser.add_argument("--mongo-shell", default="mongo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=27117)
    parser.add_argument("--properties")
    parser.add_argument("--status-url", default="https://127.0.0.1:8443/status")
    args = parser.parse_args()
    try:
        return tune(args.mongo_shell, args.host, args.port, args.properties, args.status_url, args.apply)
    except (OSError, ValueError, TuneError, subprocess.SubprocessError) as error:
        print("ОШИБКА автонастройки ресурсов: " + str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

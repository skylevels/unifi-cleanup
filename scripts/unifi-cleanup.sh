#!/bin/bash
# Bounded maintenance for the local UniFi MongoDB. Configuration stays on the host.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: unifi-cleanup.sh [--dry-run | --apply | --index-only] [--config FILE]
       unifi-cleanup.sh --install

The default mode reports the resource plan and counts eligible records.
--apply removes bounded batches
and maintains indexes and the configured UniFi memory limits.
--index-only restores indexes without pruning records or adjusting memory.
--install installs weekly maintenance, the startup hook and resource settings.
Configuration is read from /etc/unifi-cleanup.conf when it exists.
Reports are mailed only in --apply mode when REPORT_EMAIL is configured.
Retention defaults are 3 years for history and 180 days for rogue APs.
EOF
}

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

if [[ "${1:-}" == --install ]]; then
    (($# == 1)) || fail 'Use --install by itself.'
    installer_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    [[ -f "$installer_dir/install-unifi-cleanup.sh" ]] || fail 'The sibling installer is missing.'
    exec bash "$installer_dir/install-unifi-cleanup.sh"
fi

mode=dry-run
requested_mode=
config_file=/etc/unifi-cleanup.conf
explicit_config=0
while (($#)); do
    case "$1" in
        --dry-run | --apply | --index-only)
            [[ -z "$requested_mode" ]] || fail 'Choose one execution mode.'
            mode=${1#--}
            requested_mode=$mode
            shift
            ;;
        --config)
            (($# >= 2)) || fail '--config requires a file.'
            config_file=$2
            explicit_config=1
            shift 2
            ;;
        --help | -h)
            usage
            exit 0
            ;;
        --install) fail 'Use --install by itself.' ;;
        *) fail "Unknown argument: $1" ;;
    esac
done

if [[ -f "$config_file" ]]; then
    # This is an administrator-managed Bash configuration file.
    source "$config_file"
elif ((explicit_config)); then
    fail "Configuration file does not exist: $config_file"
fi

MONGO_HOST=${MONGO_HOST:-127.0.0.1}
MONGO_PORT=${MONGO_PORT:-27117}
UNIFI_PROPERTIES=${UNIFI_PROPERTIES:-}
UNIFI_STATUS_URL=${UNIFI_STATUS_URL:-https://127.0.0.1:8443/status}
BATCH_SIZE=${BATCH_SIZE:-500}
MAX_PER_COLLECTION=${MAX_PER_COLLECTION:-10000}
MAX_TOTAL=${MAX_TOTAL:-50000}
MAX_RUNTIME_SEC=${MAX_RUNTIME_SEC:-600}
QUERY_TIMEOUT_MS=${QUERY_TIMEOUT_MS:-5000}
KEEP_USER_YEARS=${KEEP_USER_YEARS:-}
KEEP_REFERENCE_YEARS=${KEEP_REFERENCE_YEARS:-}
KEEP_ROGUE_DAYS=${KEEP_ROGUE_DAYS:-180}
KEEP_DAILY_YEARS=${KEEP_DAILY_YEARS:-}
KEEP_MONTHLY_YEARS=${KEEP_MONTHLY_YEARS:-}
KEEP_ARCHIVE_YEARS=${KEEP_ARCHIVE_YEARS:-}
KEEP_WIFI_YEARS=${KEEP_WIFI_YEARS:-}
REPORT_EMAIL=${REPORT_EMAIL:-}
REPORT_FROM=${REPORT_FROM:-}
LOCK_FILE=${LOCK_FILE:-/run/lock/unifi-cleanup.lock}

[[ "$MONGO_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || fail 'Invalid MONGO_HOST.'
[[ "$REPORT_EMAIL$REPORT_FROM" != *$'\n'* && "$REPORT_EMAIL$REPORT_FROM" != *$'\r'* ]] || fail 'Mail settings must contain one line.'
for tool in timeout flock python3; do
    command -v "$tool" >/dev/null || fail "Required command is missing: $tool"
done
if [[ -n "${MONGO_SHELL:-}" ]]; then
    mongo_shell=$(command -v -- "$MONGO_SHELL") || fail 'MONGO_SHELL is unavailable.'
else
    mongo_shell=$(command -v mongo || command -v mongosh) || fail 'Install mongo or mongosh, or configure MONGO_SHELL.'
fi
[[ -x "$mongo_shell" && ! -d "$mongo_shell" ]] || fail 'MONGO_SHELL must be an executable file.'
if [[ "$mode" == apply && -n "$REPORT_EMAIL" ]]; then
    command -v mail >/dev/null || fail 'REPORT_EMAIL is configured, but mail is unavailable.'
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
engine=$script_dir/unifi-cleanup.js
[[ -f "$engine" ]] || fail "Cleanup engine is missing: $engine"
tuner=$script_dir/unifi_tune.py
[[ -f "$tuner" ]] || fail "UniFi resource helper is missing: $tuner"
if [[ "$mode" == index-only ]]; then
    # This mode also runs inside ExecStartPost while an apply job waits for UniFi.
    exec 9>"${LOCK_FILE}.index-only"
    if ! flock -w 30 9; then
        printf 'Another UniFi index restoration is running.\n' >&2
        exit 75
    fi
else
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        printf 'Another UniFi cleanup is running.\n' >&2
        exit 75
    fi
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/unifi-cleanup.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT
js_file=$work_dir/run.js
mongo_output=$work_dir/mongo-output.txt
tuning_output=$work_dir/tuning-output.txt
report_file=$work_dir/report.txt

write_js_config() {
python3 -B - "$engine" "$mode" "$1" "$MONGO_PORT" "$BATCH_SIZE" "$MAX_PER_COLLECTION" \
    "$MAX_TOTAL" "$MAX_RUNTIME_SEC" "$QUERY_TIMEOUT_MS" \
    "$KEEP_USER_YEARS" "${KEEP_USER_DAYS:-}" "$KEEP_REFERENCE_YEARS" "${KEEP_REFERENCE_DAYS:-}" \
    "$KEEP_DAILY_YEARS" "${KEEP_DAILY_DAYS:-}" "$KEEP_MONTHLY_YEARS" "${KEEP_MONTHLY_DAYS:-}" \
    "$KEEP_ARCHIVE_YEARS" "${KEEP_ARCHIVE_DAYS:-}" "$KEEP_WIFI_YEARS" "${KEEP_WIFI_DAYS:-}" \
    "$KEEP_ROGUE_DAYS" <<'PY'
import json
from pathlib import Path
import re
import sys

engine, mode, collect_heap = sys.argv[1:4]
limits = [
    ("MONGO_PORT", 1, 65535), ("BATCH_SIZE", 1, 5000),
    ("MAX_PER_COLLECTION", 1, 1000000), ("MAX_TOTAL", 1, 5000000),
    ("MAX_RUNTIME_SEC", 1, 7200), ("QUERY_TIMEOUT_MS", 100, 60000),
]
def integer(raw, name, minimum, maximum):
    if not re.fullmatch(r"[0-9]+", raw) or not minimum <= int(raw) <= maximum:
        raise SystemExit(f"Invalid {name}, expected an integer from {minimum} to {maximum}.")
    return int(raw)

if len(sys.argv) != 23:
    raise SystemExit("Invalid maintenance argument count.")
values = [integer(raw, name, minimum, maximum)
          for raw, (name, minimum, maximum) in zip(sys.argv[4:10], limits)]
retentions = ["user", "reference_name_history", "stat_daily", "stat_monthly",
              "stat_archive", "wifi_connection_event"]
policies = {}
for index, name in enumerate(retentions):
    years, days = sys.argv[10 + index * 2:12 + index * 2]
    if years:
        policies[name] = {"years": integer(years, name + " years", 1, 10)}
    elif days and integer(days, name + " legacy days", 1, 3650) != 1000:
        policies[name] = {"days": int(days)}
    else:
        policies[name] = {"years": 3}
policies["rogue"] = {"days": integer(sys.argv[22], "rogue days", 1, 3650)}
config = dict(zip(("batchSize", "maxPerCollection", "maxTotal", "maxSeconds", "maxTimeMS"), values[1:6]))
config["mode"] = mode
config["retention"] = policies
config["javaHeapBytes"] = None
if collect_heap == "1":
    try:
        sys.path.insert(0, str(Path(engine).parent))
        from unifi_tune import read_java_heap
        config["javaHeapBytes"] = read_java_heap()
    except Exception:
        # Reporting the detected heap is best effort after the checked helper run.
        pass
print("var cleanupConfig = " + json.dumps(config) + ";")
print("load(" + json.dumps(engine) + ");")
PY
}

# Validate every numeric setting before the helper can change server resources.
write_js_config 0 >"$js_file"

started=$(date -Iseconds)
printf '[%s] UniFi cleanup mode=%s\n' "$started" "$mode"
helper_mode=$mode
[[ "$mode" != index-only ]] || helper_mode=dry-run
tune_args=(python3 "$tuner" "--$helper_mode" --mongo-shell "$mongo_shell" --host "$MONGO_HOST" \
    --port "$MONGO_PORT" --status-url "$UNIFI_STATUS_URL")
if [[ -n "$UNIFI_PROPERTIES" ]]; then
    tune_args+=(--properties "$UNIFI_PROPERTIES")
fi
tuning_rc=0
timeout --signal=TERM --kill-after=10s "$((10#$MAX_RUNTIME_SEC + 30))s" \
    "${tune_args[@]}" >"$tuning_output" 2>&1 || tuning_rc=$?

mongo_rc=0
status=ERROR
if ((tuning_rc == 0)); then
    # A resource adjustment may restart UniFi and replace its Java process.
    write_js_config 1 >"$js_file"
    timeout --signal=TERM --kill-after=10s "$((10#$MAX_RUNTIME_SEC + 30))s" \
        "$mongo_shell" --norc --quiet --host "$MONGO_HOST" --port "$MONGO_PORT" ace "$js_file" \
        >"$mongo_output" 2>&1 || mongo_rc=$?
    mapfile -t markers < <(grep '^__UNIFI_CLEANUP_STATUS__=' "$mongo_output" || true)
    if ((${#markers[@]} == 1)) && [[ "$(tail -n 1 "$mongo_output")" == "${markers[0]}" ]]; then
        case "${markers[0]#__UNIFI_CLEANUP_STATUS__=}" in
            DRY_RUN | OK | LIMIT | INDEX_OK | ERROR) status=${markers[0]#__UNIFI_CLEANUP_STATUS__=} ;;
        esac
    fi
    case "$mode:$status" in
        dry-run:DRY_RUN | dry-run:LIMIT | apply:OK | apply:LIMIT | index-only:INDEX_OK) ;;
        *) status=ERROR ;;
    esac
    if ((mongo_rc != 0)); then
        status=ERROR
    fi
fi

finished=$(date -Iseconds)
{
    printf 'UniFi MongoDB cleanup\nServer: %s\nMode: %s\nStarted: %s\nFinished: %s\nStatus: %s\n\n' \
        "$(hostname)" "$mode" "$started" "$finished" "$status"
    cat "$tuning_output"
    printf '\n'
    if ((tuning_rc != 0)); then
        printf 'Resource adjustment exited with code %s. Database cleanup did not run.\n' "$tuning_rc"
    else
        grep -v '^__UNIFI_CLEANUP_STATUS__=' "$mongo_output" || true
    fi
    if ((mongo_rc != 0)); then
        printf '\nMongoDB process exited with code %s.\n' "$mongo_rc"
    fi
    if [[ "$status" == ERROR && "$mongo_rc" == 0 && "$tuning_rc" == 0 ]]; then
        printf '\nThe cleanup engine did not return a complete successful report.\n'
    fi
} >"$report_file"
cat "$report_file"

result=0
[[ "$status" != ERROR ]] || result=1
if [[ "$mode" == apply && -n "$REPORT_EMAIL" ]]; then
    mail_args=(-s "[$status] UniFi cleanup")
    if [[ -n "$REPORT_FROM" ]]; then
        mail_args+=(-a "From: $REPORT_FROM")
    fi
    if mail "${mail_args[@]}" -- "$REPORT_EMAIL" <"$report_file"; then
        printf 'Cleanup report submitted to mail.\n'
    else
        printf 'ERROR: Mail submission failed.\n' >&2
        result=1
    fi
fi
exit "$result"

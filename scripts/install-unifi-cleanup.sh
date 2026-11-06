#!/bin/bash
# Install on the UniFi controller. The first operation against MongoDB is a dry run.
set -euo pipefail

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

((EUID == 0)) || fail 'Run this installer as root on the UniFi controller.'
for tool in systemctl python3 flock timeout crontab install cmp; do
    command -v "$tool" >/dev/null || fail "Required command is missing: $tool"
done
if [[ -n "${MONGO_SHELL:-}" ]]; then
    mongo_shell=$(command -v -- "$MONGO_SHELL") || fail 'MONGO_SHELL is unavailable.'
else
    mongo_shell=$(command -v mongo || command -v mongosh) || fail 'Install mongo or mongosh, or set MONGO_SHELL.'
fi
[[ -x "$mongo_shell" && ! -d "$mongo_shell" ]] || fail 'MONGO_SHELL must be an executable file.'
systemctl cat unifi.service >/dev/null 2>&1 || fail 'unifi.service was not found on this server.'

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for file in unifi-cleanup.sh unifi-cleanup.js unifi_tune.py install-unifi-cleanup.sh; do
    [[ -f "$source_dir/$file" ]] || fail "Source file is missing: $source_dir/$file"
done

dropin=/etc/systemd/system/unifi.service.d/90-maintenance-index.conf
targets=(/opt/unifi-cleanup.sh /opt/unifi-cleanup.js /opt/unifi_tune.py /opt/install-unifi-cleanup.sh /etc/unifi-cleanup.conf "$dropin")
for target in "${targets[@]}"; do
    [[ ! -L "$target" && (! -e "$target" || -f "$target") ]] || fail "Expected a regular file: $target"
done

umask 077
work_dir=$(mktemp -d /tmp/unifi-cleanup-install.XXXXXX)
backup_dir=
restore_needed=0
cron_changed=0
reload_needed=0
original_cron_exists=0
read_root_cron() {
    local status=0
    read_cron_exists=1
    LC_ALL=C crontab -u root -l >"$1" 2>"$2" || status=$?
    if ((status != 0)); then
        if ((status == 1)) && [[ "$(cat "$2")" == 'no crontab for root' ]]; then
            read_cron_exists=0
            : >"$1"
        else
            cat "$2" >&2
            fail 'Could not read the root crontab. Installation stopped.'
        fi
    fi
}
cleanup() {
    result=$?
    trap - EXIT
    set +e
    if ((result != 0 && restore_needed)); then
        printf 'Installation failed. Restoring the previous cleanup files.\n' >&2
        for target in "${targets[@]}"; do
            name=${target##*/}
            if [[ -f "$backup_dir/$name" ]]; then
                cp -p -- "$backup_dir/$name" "$target" || printf 'ERROR: Could not restore %s\n' "$target" >&2
            else
                rm -f -- "$target" || printf 'ERROR: Could not remove installed %s\n' "$target" >&2
            fi
        done
        if ((cron_changed)); then
            if ((original_cron_exists)); then
                crontab -u root "$backup_dir/root.crontab" || printf 'ERROR: Could not restore the root crontab.\n' >&2
            else
                crontab -u root -r || printf 'ERROR: Could not remove the installed root crontab.\n' >&2
            fi
        fi
        if ((reload_needed)); then
            systemctl daemon-reload || printf 'ERROR: Could not reload the restored UniFi drop-in.\n' >&2
        fi
    fi
    for target in "${targets[@]}"; do
        rm -f -- "$target.install.$$"
    done
    rm -rf -- "$work_dir"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

read_root_cron "$work_dir/root.crontab" "$work_dir/cron-error.txt"
original_cron_exists=$read_cron_exists

install -d -o root -g root -m 0700 /var/backups/unifi-cleanup
backup_dir=$(mktemp -d "/var/backups/unifi-cleanup/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
cp -p -- "$work_dir/root.crontab" "$backup_dir/root.crontab"
if ((original_cron_exists == 0)); then
    : >"$backup_dir/root.crontab.absent"
fi
for target in "${targets[@]}"; do
    if [[ -f "$target" ]]; then
        cp -p -- "$target" "$backup_dir/${target##*/}"
    fi
done

install -m 0750 "$source_dir/unifi-cleanup.sh" "$work_dir/unifi-cleanup.sh"
install -m 0640 "$source_dir/unifi-cleanup.js" "$work_dir/unifi-cleanup.js"
install -m 0640 "$source_dir/unifi_tune.py" "$work_dir/unifi_tune.py"
install -m 0750 "$source_dir/install-unifi-cleanup.sh" "$work_dir/install-unifi-cleanup.sh"
printf '[Service]\nExecStartPost=-+%s --kill-after=10s 240s /opt/unifi-cleanup.sh --index-only\n' \
    "$(command -v timeout)" >"$work_dir/90-maintenance-index.conf"
if [[ -f /etc/unifi-cleanup.conf ]]; then
    install -m 0600 /etc/unifi-cleanup.conf "$work_dir/unifi-cleanup.conf"
fi

python3 - /opt/unifi-cleanup.sh "$work_dir/unifi-cleanup.conf" \
    "$work_dir/root.crontab" "$work_dir/next.crontab" <<'PY'
from pathlib import Path
import os
import re
import shlex
import sys

old_script, config_path, cron_path, next_cron_path = map(Path, sys.argv[1:])
if not config_path.exists():
    mail = {"REPORT_EMAIL": "", "REPORT_FROM": ""}
    if old_script.exists():
        for line in old_script.read_text().splitlines():
            match = re.match(r"^\s*(?:export\s+)?(REPORT_EMAIL|REPORT_FROM)\s*=(.*)$", line)
            if not match:
                continue
            key, expression = match.groups()
            lexer = shlex.shlex(expression, posix=True, punctuation_chars=";&|<>()")
            lexer.whitespace_split = True
            try:
                words = list(lexer)
            except ValueError:
                raise SystemExit(f"Cannot safely migrate {key}. Create /etc/unifi-cleanup.conf explicitly.")
            if len(words) > 1 or any(marker in expression for marker in ("$", "`")):
                raise SystemExit(f"Cannot safely migrate {key}. Create /etc/unifi-cleanup.conf explicitly.")
            mail[key] = words[0] if words else ""
    config = ["# UniFi maintenance configuration. Keep this file readable by root only."]
    config.extend(key + "=" + shlex.quote(value) for key, value in mail.items())
    properties = os.environ.get("UNIFI_PROPERTIES", "")
    if properties:
        properties = str(Path(properties).resolve())
    else:
        properties = next((str(path) for path in (
            Path("/var/lib/unifi/system.properties"),
            Path("/usr/lib/unifi/data/system.properties"),
            Path("/opt/unifi/data/system.properties")) if path.is_file()), "")
    config.extend([
        "MONGO_SHELL=" + shlex.quote(os.environ.get("MONGO_SHELL", "")),
        "UNIFI_PROPERTIES=" + shlex.quote(properties),
        "UNIFI_STATUS_URL=" + shlex.quote(os.environ.get(
            "UNIFI_STATUS_URL", "https://127.0.0.1:8443/status")),
    ])
    config.extend([
        "MONGO_HOST=127.0.0.1", "MONGO_PORT=27117", "BATCH_SIZE=500",
        "MAX_PER_COLLECTION=10000", "MAX_TOTAL=50000", "MAX_RUNTIME_SEC=600",
        "QUERY_TIMEOUT_MS=5000", "KEEP_USER_YEARS=3", "KEEP_REFERENCE_YEARS=3",
        "KEEP_ROGUE_DAYS=180", "KEEP_DAILY_YEARS=3", "KEEP_MONTHLY_YEARS=3",
        "KEEP_ARCHIVE_YEARS=3", "KEEP_WIFI_YEARS=3",
    ])
    config_path.write_text("\n".join(config) + "\n")
    config_path.chmod(0o600)
else:
    # Migrate literal defaults without executing the administrator's configuration.
    original = config_path.read_text()
    lines = original.splitlines(keepends=True)
    old_keys = {"KEEP_" + name + "_DAYS": "KEEP_" + name + "_YEARS"
                for name in ("USER", "REFERENCE", "DAILY", "MONTHLY", "ARCHIVE", "WIFI")}
    obsolete = {"KEEP_5MIN_DAYS", "KEEP_HOURLY_DAYS"}
    assignments = {}
    for index, line in enumerate(lines):
        match = re.match(r"^\s*(?:export\s+)?(KEEP_[A-Z_0-9]+)\s*=(.*)$", line.rstrip("\r\n"))
        if not match:
            continue
        key, expression = match.groups()
        value = None
        try:
            lexer = shlex.shlex(expression, posix=True, punctuation_chars=";&|<>()")
            lexer.whitespace_split = True
            words = list(lexer)
            if len(words) == 1 and not any(marker in expression for marker in ("$", "`")):
                value = words[0]
        except ValueError:
            pass
        assignments.setdefault(key, []).append((index, value))
    by_line = {index: (key, value) for key, rows in assignments.items() for index, value in rows}
    changed = []
    for index, line in enumerate(lines):
        item = by_line.get(index)
        if item is None:
            changed.append(line)
            continue
        key, value = item
        rows = assignments.get(key, [])
        has_dependency = any(re.search(r"\b" + re.escape(key) + r"\b", other)
                             for pos, other in enumerate(lines) if pos not in [row[0] for row in rows])
        if key in obsolete and value is not None and not has_dependency:
            continue
        if (key in old_keys and value is not None and re.fullmatch(r"0*1000", value)
                and all(raw is not None for _, raw in rows) and not has_dependency):
            if index == rows[-1][0] and old_keys[key] not in assignments:
                changed.append(old_keys[key] + "=3\n")
            continue
        changed.append(line)
    result = "".join(changed)
    if result != original:
        config_path.write_text(result)

schedule = "0 3 * * 0 /opt/unifi-cleanup.sh --apply >> /var/log/unifi-cleanup.log 2>&1\n"
output = []
replaced = 0
for line in cron_path.read_text().splitlines(keepends=True):
    fields = line.split(None, 5)
    direct = False
    if (not line.lstrip().startswith("#") and len(fields) == 6
            and all(re.fullmatch(r"[A-Za-z0-9*/,-]+", field) for field in fields[:5])):
        lexer = shlex.shlex(fields[5], posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        try:
            direct = lexer.get_token() == "/opt/unifi-cleanup.sh"
        except ValueError:
            raise SystemExit("Could not parse a scheduled command. Inspect the root crontab.")
    if direct:
        if replaced == 0:
            output.append(schedule)
        replaced += 1
    else:
        output.append(line)
if replaced == 0:
    if output and not output[-1].endswith("\n"):
        output.append("\n")
    output.append(schedule)
next_cron_path.write_text("".join(output))
print(f"Direct cleanup cron entries replaced: {replaced}")
PY

if ! bash "$work_dir/unifi-cleanup.sh" --dry-run --config "$work_dir/unifi-cleanup.conf" \
    >"$backup_dir/dry-run.log" 2>&1; then
    cat "$backup_dir/dry-run.log" >&2
    fail "Dry run failed. Inspect $backup_dir/dry-run.log before installing."
fi
cat "$backup_dir/dry-run.log"
grep -q '^Status: DRY_RUN$' "$backup_dir/dry-run.log" || fail 'The dry run did not finish fully. Review its limits before installing.'

read_root_cron "$work_dir/current.crontab" "$work_dir/cron-error.txt"
((read_cron_exists == original_cron_exists)) || fail 'The root crontab changed during the dry run. Re-run the installer.'
cmp -s "$work_dir/current.crontab" "$work_dir/root.crontab" || fail 'The root crontab changed during the dry run. Re-run the installer.'
for target in "${targets[@]}"; do
    name=${target##*/}
    if [[ -f "$backup_dir/$name" ]]; then
        cmp -s "$target" "$backup_dir/$name" || fail "File changed during the dry run: $target"
    else
        [[ ! -e "$target" ]] || fail "File appeared during the dry run: $target"
    fi
done

replace_file() {
    install -o root -g root -m "$3" "$1" "$2.install.$$"
    mv -f -- "$2.install.$$" "$2"
}
restore_needed=1
replace_file "$work_dir/unifi-cleanup.conf" /etc/unifi-cleanup.conf 0600
replace_file "$work_dir/unifi-cleanup.js" /opt/unifi-cleanup.js 0640
replace_file "$work_dir/unifi_tune.py" /opt/unifi_tune.py 0640
replace_file "$work_dir/install-unifi-cleanup.sh" /opt/install-unifi-cleanup.sh 0750
replace_file "$work_dir/unifi-cleanup.sh" /opt/unifi-cleanup.sh 0750
install -d -o root -g root -m 0755 "${dropin%/*}"
reload_needed=1
replace_file "$work_dir/90-maintenance-index.conf" "$dropin" 0644
systemctl daemon-reload
if ! bash /opt/unifi-cleanup.sh --index-only --config /etc/unifi-cleanup.conf \
    >"$backup_dir/index-only.log" 2>&1; then
    cat "$backup_dir/index-only.log" >&2
    fail "Index restoration failed. Inspect $backup_dir/index-only.log."
fi
cat "$backup_dir/index-only.log"
grep -q '^Status: INDEX_OK$' "$backup_dir/index-only.log" || fail 'Index restoration did not return INDEX_OK.'
cron_changed=1
crontab -u root "$work_dir/next.crontab"
if ! (
    source /etc/unifi-cleanup.conf || exit 1
    if [[ -n "${MONGO_SHELL:-}" ]]; then
        selected_shell=$(command -v -- "$MONGO_SHELL") || exit 1
    else
        selected_shell=$(command -v mongo || command -v mongosh) || exit 1
    fi
    [[ -x "$selected_shell" && ! -d "$selected_shell" ]] || exit 1
    tune_args=(python3 /opt/unifi_tune.py --apply --mongo-shell "$selected_shell" \
        --host "${MONGO_HOST:-127.0.0.1}" --port "${MONGO_PORT:-27117}" \
        --status-url "${UNIFI_STATUS_URL:-https://127.0.0.1:8443/status}")
    if [[ -n "${UNIFI_PROPERTIES:-}" ]]; then
        tune_args+=(--properties "$UNIFI_PROPERTIES")
    fi
    "${tune_args[@]}"
) >"$backup_dir/resource-apply.log" 2>&1; then
    cat "$backup_dir/resource-apply.log" >&2
    fail "Resource adjustment failed. Inspect $backup_dir/resource-apply.log."
fi
cat "$backup_dir/resource-apply.log"
if ! bash /opt/unifi-cleanup.sh --index-only --config /etc/unifi-cleanup.conf \
    >"$backup_dir/final-index-only.log" 2>&1; then
    cat "$backup_dir/final-index-only.log" >&2
    fail "Final index verification failed. Inspect $backup_dir/final-index-only.log."
fi
cat "$backup_dir/final-index-only.log"
grep -q '^Status: INDEX_OK$' "$backup_dir/final-index-only.log" || fail 'Final index verification did not return INDEX_OK.'
restore_needed=0

printf '\nUniFi cleanup installed. Private backup: %s\n' "$backup_dir"
printf 'UniFi startup index restoration is installed.\n'
printf 'Weekly root cron entry:\n'
grep '^0 3 \* \* 0 /opt/unifi-cleanup.sh --apply ' "$work_dir/next.crontab"

"""Maintenance regressions use fake executables and never contact MongoDB or mail."""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]


class UniFiCleanupWrapperCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.bin = self.work / 'bin'
        self.bin.mkdir()
        self.config = self.work / 'config'
        self.config.write_text('')
        properties = self.work / 'system.properties'
        properties.write_text('unifi.xmx=4096\ndb.mongo.wt.cache_size=1024\n')
        class StatusHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"meta":{"rc":"ok","up":true},"data":[]}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.status = ThreadingHTTPServer(('127.0.0.1', 0), StatusHandler)
        self.status_thread = threading.Thread(target=lambda: self.status.serve_forever(poll_interval=0.01), daemon=True)
        self.status_thread.start()
        self.addCleanup(self.status.server_close)
        self.addCleanup(self.status.shutdown)
        self.env = os.environ.copy()
        for name in tuple(self.env):
            if name.startswith(('KEEP_', 'REPORT_', 'MONGO_', 'MAX_')) or name in ('BATCH_SIZE', 'QUERY_TIMEOUT_MS'):
                self.env.pop(name)
        self.env.update(PATH=str(self.bin) + os.pathsep + self.env['PATH'],
                        LOCK_FILE=str(self.work / 'lock'), TMPDIR=str(self.work),
                        TEST_CONFIG=str(self.work / 'captured.js'), TEST_MAIL=str(self.work / 'mail'),
                        UNIFI_PROPERTIES=str(properties),
                        UNIFI_STATUS_URL='http://127.0.0.1:' + str(self.status.server_port) + '/status')
        self.executable('mongo', '''import os, pathlib, shutil, sys
if '--eval' in sys.argv:
    print('{"cacheBytes":1073741824}')
    sys.exit(0)
shutil.copyfile(sys.argv[-1], os.environ['TEST_CONFIG'])
print('Synthetic maintenance report')
status = os.environ.get('FAKE_STATUS', 'DRY_RUN')
if status != 'MISSING':
    print('__UNIFI_CLEANUP_STATUS__=' + status)
if os.environ.get('FAKE_DUPLICATE'):
    print('__UNIFI_CLEANUP_STATUS__=' + status)
sys.exit(int(os.environ.get('FAKE_MONGO_RC', '0')))
''')
        self.executable('mail', '''import os, pathlib, sys
pathlib.Path(os.environ['TEST_MAIL']).write_text(sys.stdin.read())
sys.exit(int(os.environ.get('FAKE_MAIL_RC', '0')))
''')
        self.executable('systemctl', '''import os
print(os.environ.get('TEST_JAVA_PID', '0'))
''')

    def executable(self, name, code):
        path = self.bin / name
        path.write_text('#!/usr/bin/env python3\n' + code)
        path.chmod(0o755)

    def run_wrapper(self, *args, **env):
        return subprocess.run(['bash', str(ROOT / 'scripts/unifi-cleanup.sh'),
                               '--config', str(self.config), *args],
                              env=dict(self.env, **env), text=True, capture_output=True, timeout=10)

    def captured_config(self):
        line = Path(self.env['TEST_CONFIG']).read_text().splitlines()[0]
        return json.loads(line.removeprefix('var cleanupConfig = ').removesuffix(';'))

    def test_default_is_read_only_with_existing_retention_and_no_mail(self):
        result = self.run_wrapper(REPORT_EMAIL='ops@example.org')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.captured_config()
        self.assertEqual(config['mode'], 'dry-run')
        self.assertEqual(config['retention'], {
            'user': {'years': 3}, 'reference_name_history': {'years': 3},
            'rogue': {'days': 180}, 'stat_daily': {'years': 3},
            'stat_monthly': {'years': 3}, 'stat_archive': {'years': 3},
            'wifi_connection_event': {'years': 3},
        })
        self.assertFalse(Path(self.env['TEST_MAIL']).exists())
        self.assertFalse(list(self.work.glob('unifi-cleanup.*')))

    def test_legacy_default_configuration_uses_three_year_policy(self):
        self.config.write_text('\n'.join('KEEP_' + name + '_DAYS=1000' for name in
                               ('USER', 'REFERENCE', 'DAILY', 'MONTHLY', 'ARCHIVE', 'WIFI')) +
                               '\nKEEP_5MIN_DAYS=unused\nKEEP_HOURLY_DAYS=unused\n')
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        retention = self.captured_config()['retention']
        self.assertEqual(set(retention), {'user', 'reference_name_history', 'rogue', 'stat_daily',
                                        'stat_monthly', 'stat_archive', 'wifi_connection_event'})
        self.assertTrue(all(policy == {'years': 3} for name, policy in retention.items() if name != 'rogue'))

    def test_retention_arguments_keep_their_collection_and_unit(self):
        self.config.write_text('KEEP_USER_YEARS=1\nKEEP_REFERENCE_YEARS=2\nKEEP_DAILY_YEARS=3\n'
                               'KEEP_MONTHLY_YEARS=4\nKEEP_ARCHIVE_YEARS=5\nKEEP_WIFI_YEARS=6\n'
                               'KEEP_ROGUE_DAYS=181\nKEEP_USER_DAYS=1000\n')
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.captured_config()['retention'], {
            'user': {'years': 1}, 'reference_name_history': {'years': 2},
            'stat_daily': {'years': 3}, 'stat_monthly': {'years': 4},
            'stat_archive': {'years': 5}, 'wifi_connection_event': {'years': 6},
            'rogue': {'days': 181},
        })

    def test_custom_legacy_days_are_preserved_and_explicit_years_take_precedence(self):
        self.config.write_text('KEEP_USER_DAYS=730\nKEEP_REFERENCE_DAYS=900\nKEEP_REFERENCE_YEARS=4\n')
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        retention = self.captured_config()['retention']
        self.assertEqual(retention['user'], {'days': 730})
        self.assertEqual(retention['reference_name_history'], {'years': 4})

    def test_invalid_years_stop_before_database_execution(self):
        for value in ('0', '11', 'invalid'):
            with self.subTest(value=value):
                result = self.run_wrapper('--apply', KEEP_USER_YEARS=value)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(Path(self.env['TEST_CONFIG']).exists())

    def test_apply_reports_success_and_submits_only_fake_mail(self):
        result = self.run_wrapper('--apply', FAKE_STATUS='OK', REPORT_EMAIL='ops@example.org')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.captured_config()['mode'], 'apply')
        self.assertIn('Status: OK', Path(self.env['TEST_MAIL']).read_text())

    def test_missing_duplicate_or_wrong_mode_marker_is_failure(self):
        for env in ({'FAKE_STATUS': 'MISSING'}, {'FAKE_DUPLICATE': '1'}, {'FAKE_STATUS': 'OK'}):
            with self.subTest(env=env):
                result = self.run_wrapper(**env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Status: ERROR', result.stdout)

    def test_nonzero_mongo_exit_overrides_success_marker(self):
        result = self.run_wrapper('--apply', FAKE_STATUS='OK', FAKE_MONGO_RC='2')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Status: ERROR', result.stdout)

    def test_limit_is_reported_without_falsely_claiming_completion(self):
        for args in ((), ('--apply',)):
            with self.subTest(args=args):
                result = self.run_wrapper(*args, FAKE_STATUS='LIMIT')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('Status: LIMIT', result.stdout)

    def test_mail_submission_failure_is_a_failed_run(self):
        result = self.run_wrapper('--apply', FAKE_STATUS='OK', REPORT_EMAIL='ops@example.org', FAKE_MAIL_RC='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Mail submission failed', result.stderr)

    def test_invalid_limit_stops_before_mongo(self):
        result = self.run_wrapper('--apply', BATCH_SIZE='0')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(Path(self.env['TEST_CONFIG']).exists())

    def test_lock_prevents_parallel_invocation(self):
        with open(self.env['LOCK_FILE'], 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_wrapper()
        self.assertEqual(result.returncode, 75)
        self.assertFalse(Path(self.env['TEST_CONFIG']).exists())

    def test_java_heap_is_read_from_service_process_and_last_flag_wins(self):
        cases = [(['-Xmx2048m'], 2 * 1024 ** 3),
                 (['-Xmx1g', '-Xmx4096M'], 4 * 1024 ** 3),
                 (['-Xmx4g', '-XX:MaxHeapSize=8589934592'], 8 * 1024 ** 3)]
        for flags, expected in cases:
            with self.subTest(flags=flags):
                process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(15)', *flags])
                try:
                    result = self.run_wrapper(TEST_JAVA_PID=str(process.pid))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.captured_config()['javaHeapBytes'], expected)
                finally:
                    process.terminate()
                    process.wait(timeout=5)

    def test_unavailable_java_heap_remains_unknown(self):
        result = self.run_wrapper(TEST_JAVA_PID='0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.captured_config()['javaHeapBytes'])

    def test_startup_index_only_runs_while_normal_maintenance_holds_lock(self):
        with open(self.env['LOCK_FILE'], 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_wrapper('--index-only', FAKE_STATUS='INDEX_OK', REPORT_EMAIL='ops@example.org')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.captured_config()['mode'], 'index-only')
        self.assertFalse(Path(self.env['TEST_MAIL']).exists())

    def test_startup_mode_rejects_ordinary_cleanup_success(self):
        result = self.run_wrapper('--index-only', FAKE_STATUS='OK')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Status: ERROR', result.stdout)

    def test_install_dispatches_before_runtime_configuration_is_needed(self):
        source = self.work / 'source'
        source.mkdir()
        wrapper = source / 'unifi-cleanup.sh'
        shutil.copyfile(ROOT / 'scripts/unifi-cleanup.sh', wrapper)
        installer = source / 'install-unifi-cleanup.sh'
        marker = source / 'called'
        installer.write_text('#!/bin/bash\nprintf installed > "$TEST_INSTALL_MARKER"\n')
        result = subprocess.run(['bash', str(wrapper), '--install'],
                                env=dict(self.env, TEST_INSTALL_MARKER=str(marker)),
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(), 'installed')
        result = subprocess.run(['bash', str(wrapper), '--install', '--apply'],
                                env=self.env, text=True, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)


class UniFiCleanupEngineCase(unittest.TestCase):
    def test_javascript_regressions(self):
        node = shutil.which('node') or shutil.which('nodejs')
        mongo = shutil.which('mongo')
        if node:
            command = [node, 'tests/unifi_cleanup_cases.js']
        elif mongo:
            command = [mongo, '--nodb', '--norc', '--quiet', 'tests/unifi_cleanup_cases.js']
        else:
            self.skipTest('Requires node or mongo --nodb, with a fake database in both cases')
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('cleanup regression cases passed', result.stdout)


class UniFiCleanupInstallerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.old_script = self.work / 'old.sh'
        self.config = self.work / 'config'
        self.cron = self.work / 'cron'
        self.next_cron = self.work / 'next'
        installer = (ROOT / 'scripts/install-unifi-cleanup.sh').read_text()
        self.helper = installer.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]

    def prepare(self):
        return subprocess.run([shutil.which('python3'), '-', str(self.old_script), str(self.config),
                               str(self.cron), str(self.next_cron)],
                              input=self.helper, text=True, capture_output=True, timeout=5)

    def test_replaces_only_own_cron_entries_and_preserves_literal_mail(self):
        self.old_script.write_text('REPORT_EMAIL="ops@example.org"\nREPORT_FROM="unifi@example.org"\nexit 99\n')
        self.cron.write_text('# Keep this comment\nMAILTO=root\n'
                             '0 3 1 * * /opt/unifi-cleanup.sh >> /var/log/unifi-cleanup.log 2>&1\n'
                             '0 4 * * 0 "/opt/unifi-cleanup.sh" --apply\n'
                             '0 5 * * * /opt/other-maintenance.sh\n')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        cron = self.next_cron.read_text()
        self.assertIn('# Keep this comment\nMAILTO=root\n', cron)
        self.assertEqual(cron.count('/opt/unifi-cleanup.sh'), 1)
        self.assertIn('0 3 * * 0 /opt/unifi-cleanup.sh --apply', cron)
        self.assertIn('0 5 * * * /opt/other-maintenance.sh\n', cron)
        self.assertIn('REPORT_EMAIL=ops@example.org', self.config.read_text())
        self.assertIn('KEEP_USER_YEARS=3', self.config.read_text())
        self.assertIn('KEEP_ROGUE_DAYS=180', self.config.read_text())
        self.assertNotIn('KEEP_5MIN_DAYS', self.config.read_text())
        self.assertNotIn('KEEP_HOURLY_DAYS', self.config.read_text())

    def test_migrates_previous_default_retention_without_changing_other_settings(self):
        self.config.write_text('# Local settings\nREPORT_EMAIL=custom@example.org\nBATCH_SIZE=70\n' +
                               '\n'.join('KEEP_' + name + '_DAYS=1000' for name in
                               ('USER', 'REFERENCE', 'DAILY', 'MONTHLY', 'ARCHIVE', 'WIFI')) +
                               '\nKEEP_ROGUE_DAYS=181\nKEEP_5MIN_DAYS=60\nKEEP_HOURLY_DAYS=180\n')
        self.cron.write_text('')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.config.read_text()
        self.assertIn('# Local settings\nREPORT_EMAIL=custom@example.org\nBATCH_SIZE=70\n', config)
        for name in ('USER', 'REFERENCE', 'DAILY', 'MONTHLY', 'ARCHIVE', 'WIFI'):
            self.assertIn('KEEP_' + name + '_YEARS=3\n', config)
            self.assertNotIn('KEEP_' + name + '_DAYS=', config)
        self.assertIn('KEEP_ROGUE_DAYS=181\n', config)
        self.assertNotIn('KEEP_5MIN_DAYS', config)
        self.assertNotIn('KEEP_HOURLY_DAYS', config)

    def test_migration_preserves_custom_days_and_existing_years(self):
        self.config.write_text('REPORT_EMAIL=custom@example.org\nKEEP_USER_DAYS=730\n'
                               'KEEP_REFERENCE_DAYS=1000\nKEEP_REFERENCE_YEARS=4\n')
        self.cron.write_text('')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('KEEP_USER_DAYS=730\n', self.config.read_text())
        self.assertNotIn('KEEP_USER_YEARS=', self.config.read_text())
        self.assertIn('KEEP_REFERENCE_YEARS=4\n', self.config.read_text())
        self.assertNotIn('KEEP_REFERENCE_DAYS=', self.config.read_text())

    def test_migration_respects_last_literal_assignment(self):
        self.config.write_text('KEEP_USER_DAYS=1000\nKEEP_USER_DAYS=730\n'
                               'KEEP_REFERENCE_DAYS=730\nKEEP_REFERENCE_DAYS=1000\n')
        self.cron.write_text('')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), 'KEEP_USER_DAYS=730\nKEEP_REFERENCE_DAYS=730\n'
                                                'KEEP_REFERENCE_YEARS=3\n')

    def test_migration_does_not_execute_or_rewrite_dependent_shell_logic(self):
        touched = self.work / 'should-not-exist'
        original = ('KEEP_USER_DAYS=1000\n'
                    'KEEP_USER_YEARS=$((KEEP_USER_DAYS / 365))\n'
                    'KEEP_REFERENCE_DAYS=$(touch ' + str(touched) + ')\n')
        self.config.write_text(original)
        self.cron.write_text('')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(touched.exists())
        self.assertEqual(self.config.read_text(), original)

    def test_migration_keeps_obsolete_variables_used_by_other_configuration(self):
        original = ('KEEP_5MIN_DAYS=60\nKEEP_HOURLY_DAYS=180\n'
                    'MAX_TOTAL=$((KEEP_HOURLY_DAYS * 20))\nMAX_RUNTIME_SEC=$KEEP_5MIN_DAYS\n')
        self.config.write_text(original)
        self.cron.write_text('')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), original)

    def test_existing_configuration_is_preserved_exactly(self):
        self.config.write_text('REPORT_EMAIL=custom@example.org\nKEEP_USER_DAYS=730\n')
        before = self.config.read_bytes()
        self.cron.write_text('0 5 * * * /opt/other-maintenance.sh')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_bytes(), before)
        self.assertIn('/opt/other-maintenance.sh\n0 3 * * 0 ', self.next_cron.read_text())

    def test_dynamic_old_assignment_is_rejected_without_execution(self):
        touched = self.work / 'should-not-exist'
        self.old_script.write_text('REPORT_EMAIL="$(touch ' + str(touched) + ')"\n')
        self.cron.write_text('0 3 1 * * /opt/unifi-cleanup.sh\n')
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(touched.exists())
        self.assertFalse(self.next_cron.exists())

"""Memory tuning tests never contact a controller or execute systemctl."""
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('unifi_tune_tests_target', ROOT / 'scripts/unifi_tune.py')
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)


class UniFiTuneCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.properties = self.work / 'system.properties'
        self.original = '# Existing settings\nunifi.xmx=1024\nunifi.xms=1024\n' \
                        'db.mongo.wt.cache_size=256\nother.property=keep\n'
        self.properties.write_text(self.original)
        self.properties.chmod(0o640)
        self.output = io.StringIO()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(redirect_stdout(self.output))
        self.ready = self.stack.enter_context(patch.object(T, 'wait_initial_ready', return_value=256 * T.MIB))
        self.heap = self.stack.enter_context(patch.object(T, 'read_java_heap', return_value=1024 * T.MIB))
        self.memory = self.stack.enter_context(patch.object(T, 'read_mem_total', return_value=8192 * T.MIB))
        self.restart = self.stack.enter_context(patch.object(T, 'restart_service'))
        self.verify = self.stack.enter_context(patch.object(T, 'wait_for_runtime',
                                                         return_value=(1024 * T.MIB, 4096 * T.MIB)))
        self.stack.enter_context(patch.object(T.os, 'geteuid', return_value=0))

    def tune(self, apply=True, path=None):
        return T.tune('mongo', '127.0.0.1', 27117, str(path or self.properties),
                      'https://127.0.0.1:8443/status', apply, self.work / 'backups')

    def test_dry_run_plans_only_without_writes_or_restart(self):
        self.assertEqual(self.tune(apply=False), 0)
        self.assertEqual(self.properties.read_text(), self.original)
        self.assertFalse((self.work / 'backups').exists())
        self.restart.assert_not_called()
        self.assertIn('unifi.xmx=4096', self.output.getvalue())

    def test_apply_raises_both_limits_and_verifies_ready_runtime(self):
        self.assertEqual(self.tune(), 0)
        properties = T.property_values(self.properties.read_text())
        self.assertEqual(properties['unifi.xmx'], '4096')
        self.assertEqual(properties['db.mongo.wt.cache_size'], '1024')
        self.assertEqual(properties['db.mongo.wt.cache_size_default'], 'false')
        self.assertEqual(properties['other.property'], 'keep')
        self.assertEqual(stat.S_IMODE(self.properties.stat().st_mode), 0o640)
        self.restart.assert_called_once()
        self.assertEqual(self.verify.call_args.args[4:], (1024 * T.MIB, 4096 * T.MIB))
        backups = list((self.work / 'backups').glob('tuning-*/system.properties'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), self.original)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)

    def test_existing_higher_properties_are_preserved_when_runtime_is_lower(self):
        self.properties.write_text('unifi.xmx=6144\nunifi.xms=1024\ndb.mongo.wt.cache_size=1536\n')
        self.memory.return_value = 16384 * T.MIB
        self.verify.return_value = (1536 * T.MIB, 6144 * T.MIB)
        self.assertEqual(self.tune(), 0)
        values = T.property_values(self.properties.read_text())
        self.assertEqual(values['unifi.xmx'], '6144')
        self.assertEqual(values['db.mongo.wt.cache_size'], '1536')

    def test_raising_cache_preserves_higher_runtime_heap_despite_stale_file(self):
        self.heap.return_value = 4096 * T.MIB
        self.assertEqual(self.tune(), 0)
        self.assertEqual(T.property_values(self.properties.read_text())['unifi.xmx'], '4096')

    def test_raising_heap_preserves_higher_runtime_cache_despite_stale_file(self):
        self.ready.return_value = 2048 * T.MIB
        self.verify.return_value = (2048 * T.MIB, 4096 * T.MIB)
        self.assertEqual(self.tune(), 0)
        self.assertEqual(T.property_values(self.properties.read_text())['db.mongo.wt.cache_size'], '2048')

    def test_sufficient_runtime_is_checked_but_never_restarted(self):
        self.ready.return_value = 1024 * T.MIB
        self.heap.return_value = 8192 * T.MIB
        self.assertEqual(self.tune(), 0)
        self.restart.assert_not_called()
        self.assertEqual(self.properties.read_text(), self.original)
        self.ready.assert_called_once()

    def test_unknown_heap_skips_without_lowering_higher_configuration(self):
        self.heap.return_value = None
        self.properties.write_text('unifi.xmx=16384\n')
        self.assertEqual(self.tune(), 0)
        self.restart.assert_not_called()
        self.assertEqual(self.properties.read_text(), 'unifi.xmx=16384\n')
        self.assertIn('не удалось проверить', self.output.getvalue())

    def test_insufficient_physical_memory_reports_skip(self):
        self.memory.return_value = 4096 * T.MIB
        self.assertEqual(self.tune(), 0)
        self.assertEqual(self.properties.read_text(), self.original)
        self.restart.assert_not_called()
        self.assertIn('Увеличьте RAM', self.output.getvalue())

    def test_restart_failure_restores_properties_and_still_returns_error(self):
        self.restart.side_effect = [subprocess.CalledProcessError(1, ['systemctl']), None]
        self.assertEqual(self.tune(), 2)
        self.assertEqual(self.properties.read_text(), self.original)
        self.assertEqual(self.restart.call_count, 2)
        self.assertIn('Предыдущая конфигурация восстановлена', self.output.getvalue())

    def test_failed_verification_restores_before_successful_rollback(self):
        self.verify.side_effect = [T.TuneError('limits not applied'), (256 * T.MIB, 1024 * T.MIB)]
        self.assertEqual(self.tune(), 2)
        self.assertEqual(self.properties.read_text(), self.original)
        self.assertEqual(self.restart.call_count, 2)

    def test_failed_rollback_is_reported_with_recovery_backup(self):
        self.restart.side_effect = RuntimeError('synthetic failure')
        self.assertEqual(self.tune(), 2)
        self.assertEqual(self.properties.read_text(), self.original)
        self.assertIn('ОШИБКА восстановления', self.output.getvalue())

    def test_symlink_is_kept_and_its_target_updated(self):
        link = self.work / 'alias.properties'
        link.symlink_to(self.properties)
        self.assertEqual(self.tune(path=link), 0)
        self.assertTrue(link.is_symlink())
        self.assertEqual(T.property_values(self.properties.read_text())['unifi.xmx'], '4096')

    def test_new_initialized_data_directory_can_receive_properties_file(self):
        self.properties.unlink()
        self.assertEqual(self.tune(), 0)
        self.assertEqual(T.property_values(self.properties.read_text())['db.mongo.wt.cache_size'], '1024')
        self.assertEqual(stat.S_IMODE(self.properties.stat().st_mode), 0o600)
        markers = list((self.work / 'backups').glob('tuning-*/system.properties.absent'))
        self.assertEqual(len(markers), 1)

    def test_failed_tuning_removes_new_properties_file_on_rollback(self):
        self.properties.unlink()
        self.verify.side_effect = [T.TuneError('synthetic check failure'), (256 * T.MIB, 1024 * T.MIB)]
        self.assertEqual(self.tune(), 2)
        self.assertFalse(self.properties.exists())
        self.assertEqual(self.restart.call_count, 2)


class UniFiTuneHelpersCase(unittest.TestCase):
    def test_parse_heap_units_and_later_flag_precedence(self):
        for flags, expected in [(['-Xmx4096M'], 4096 * T.MIB),
                                (['-Xmx4g'], 4096 * T.MIB),
                                (['-Xmx4g', '-XX:MaxHeapSize=8589934592'], 8192 * T.MIB),
                                (['-Xmx512k'], 512 * 1024),
                                (['-Xmx0', '-Dunifi.xmx=4096'], None)]:
            with self.subTest(flags=flags):
                self.assertEqual(T.parse_heap_flags(flags), expected)

    def test_read_java_heap_only_reads_the_service_process(self):
        with patch.object(T.subprocess, 'check_output', return_value='123\n'), \
                patch.object(T.Path, 'read_bytes', return_value=b'java\0-Xmx4096M\0'):
            self.assertEqual(T.read_java_heap(), 4096 * T.MIB)
        with patch.object(T.subprocess, 'check_output', return_value='0\n'):
            self.assertIsNone(T.read_java_heap())

    def test_cache_json_ignores_shell_notices_and_preserves_real_limit(self):
        result = subprocess.CompletedProcess([], 0, 'shell notice\n{"cacheBytes":536870912}\n', '')
        with patch.object(T.subprocess, 'run', return_value=result) as command:
            self.assertEqual(T.read_mongo_cache('mongosh', '127.0.0.1', 27117), 512 * T.MIB)
        self.assertEqual(command.call_args.args[0][0], 'mongosh')

    def test_upsert_removes_duplicate_target_keys_and_preserves_other_lines(self):
        original = '# keep\nunifi.xmx: 1024\nunifi.xmx 2048\nother=значение\n'
        changed = T.updated_properties(original, {'unifi.xmx': '4096'})
        self.assertEqual(changed, '# keep\nother=значение\nunifi.xmx=4096\n')

    def test_initial_readiness_precedes_mongo_and_can_time_out(self):
        with patch.object(T, 'status_ready', side_effect=[False, True]), \
                patch.object(T, 'read_mongo_cache', return_value=512 * T.MIB) as read, \
                patch.object(T.time, 'sleep') as sleep, \
                patch.object(T.time, 'monotonic', side_effect=[0, 0, 1]):
            self.assertEqual(T.wait_initial_ready('mongo', '127.0.0.1', 27117, 'https://localhost/status'), 512 * T.MIB)
            read.assert_called_once()
            sleep.assert_called_once_with(2)
        with patch.object(T, 'status_ready', return_value=False), patch.object(T.time, 'sleep'), \
                patch.object(T.time, 'monotonic', side_effect=[0, 0, 60]):
            with self.assertRaises(T.TuneError):
                T.wait_initial_ready('mongo', '127.0.0.1', 27117, 'https://localhost/status')

    def test_postrestart_verification_rejects_unapplied_limit(self):
        with patch.object(T, 'status_ready', return_value=True), \
                patch.object(T, 'read_mongo_cache', return_value=256 * T.MIB), \
                patch.object(T, 'read_java_heap', return_value=4096 * T.MIB):
            with self.assertRaises(T.TuneError):
                T.wait_for_runtime('mongo', '127.0.0.1', 27117, 'https://localhost/status', 512 * T.MIB)

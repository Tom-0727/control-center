import base64
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import skills
import node


class SkillsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.home = self.base / 'node home'
        self.home.mkdir()
        (self.home / '.claude').mkdir()
        self.source = self.base / 'source'
        self.source.mkdir()
        self.manager = skills.Manager(self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def make_skill(self, root, name='review', body='first'):
        folder = root / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'SKILL.md').write_text('---\nname: ' + name + '\ndescription: Test\n---\n' + body)
        return folder

    def run_cmd(self, *args):
        return self.manager.apply(skills.parser().parse_args(list(args)))

    def sync(self, *args):
        return self.run_cmd('sync', '--source', str(self.source), *args)

    def test_preview_is_read_only_and_apply_is_idempotent(self):
        src = self.make_skill(self.source)
        plan = self.sync()
        self.assertEqual(len(plan['actions']), 2)
        self.assertFalse(self.manager.root.exists())
        self.assertFalse(self.manager.state_dir.exists())
        applied = self.sync('--apply')
        self.assertTrue(applied['applied'])
        self.assertEqual(skills.digest(src), skills.digest(self.manager.root / 'review'))
        self.assertEqual((self.manager.claude / 'review').resolve(), self.manager.root / 'review')
        again = self.sync('--apply')
        self.assertFalse(again['applied'])
        self.assertEqual(again['actions'], [])

    def test_update_preserves_unknown_node_skills_and_backs_up(self):
        src = self.make_skill(self.source)
        private = self.make_skill(self.manager.root, 'node-only')
        self.sync('--apply')
        old = (self.manager.root / 'review/SKILL.md').read_bytes()
        (src / 'SKILL.md').write_text('updated')
        result = self.sync('--apply')
        self.assertEqual((Path(result['backup']) / '0/SKILL.md').read_bytes(), old)
        self.assertTrue(private.exists())
        self.assertNotIn('node-only', self.manager.state()['managed'])

    def test_collision_stops_whole_batch(self):
        self.make_skill(self.source)
        self.make_skill(self.source, 'another')
        self.make_skill(self.manager.root, body='local variation')
        result = self.sync('--apply')
        self.assertTrue(result['conflicts'])
        self.assertFalse((self.manager.root / 'another').exists())
        self.assertFalse(self.manager.state_file.exists())

    def test_identical_unmanaged_requires_explicit_adopt(self):
        self.make_skill(self.source)
        self.make_skill(self.manager.root)
        self.assertTrue(self.sync()['conflicts'])
        self.assertTrue(self.sync('--adopt', '--apply')['applied'])
        self.assertEqual(self.manager.state()['managed']['review']['scope'], 'common')

    def test_modified_common_refuses_update_and_removal(self):
        self.make_skill(self.source)
        self.sync('--apply')
        (self.manager.root / 'review/SKILL.md').write_text('node edit')
        self.assertTrue(self.sync('--apply')['conflicts'])
        shutil.rmtree(self.source / 'review')
        self.assertTrue(self.sync('--prune', '--apply')['conflicts'])
        self.assertEqual((self.manager.root / 'review/SKILL.md').read_text(), 'node edit')

    def test_prune_is_explicit_and_only_removes_common(self):
        self.make_skill(self.source)
        self.make_skill(self.manager.root, 'local')
        self.sync('--apply')
        shutil.rmtree(self.source / 'review')
        self.sync('--apply')
        self.assertTrue((self.manager.root / 'review').exists())
        result = self.sync('--prune', '--apply')
        self.assertTrue(result['applied'])
        self.assertFalse(os.path.lexists(self.manager.claude / 'review'))
        self.assertFalse((self.manager.root / 'review').exists())
        self.assertTrue((self.manager.root / 'local').exists())

    def test_legacy_import_moves_source_to_backup_and_preserves_system(self):
        src = self.make_skill(self.manager.codex)
        self.make_skill(self.manager.codex / '.system', 'system')
        result = self.run_cmd('import', '--source', str(src), '--apply')
        self.assertTrue(result['applied'])
        self.assertTrue(src.is_symlink())
        self.assertEqual(src.resolve(), self.manager.root / 'review')
        self.assertTrue((self.manager.codex / '.system/system/SKILL.md').is_file())
        self.assertEqual(self.manager.state()['managed']['review']['scope'], 'local')

    def test_local_remove_preserves_other_skills(self):
        src = self.make_skill(self.source)
        self.run_cmd('import', '--source', str(src), '--apply')
        self.make_skill(self.manager.root, 'other')
        result = self.run_cmd('remove', 'review', '--apply')
        self.assertTrue(result['applied'])
        self.assertFalse((self.manager.root / 'review').exists())
        self.assertTrue((self.manager.root / 'other').exists())

    def test_foreign_links_are_never_retargeted(self):
        self.make_skill(self.source)
        external = self.make_skill(self.base / 'external')
        self.manager.claude.mkdir()
        (self.manager.claude / 'review').symlink_to(external)
        result = self.sync('--apply')
        self.assertTrue(result['conflicts'])
        self.assertEqual((self.manager.claude / 'review').resolve(), external)
        self.assertFalse(self.manager.root.exists())

    def test_link_repair_and_claude_absent(self):
        self.make_skill(self.source)
        (self.home / '.claude').rmdir()
        self.sync('--apply')
        self.assertFalse(self.manager.claude.exists())
        self.assertFalse(self.manager.codex.exists())
        (self.home / '.claude').mkdir()
        self.run_cmd('link', '--apply')
        self.assertTrue((self.manager.claude / 'review').is_symlink())
        (self.manager.claude / 'review').unlink()
        self.run_cmd('link', '--apply')
        self.assertTrue((self.manager.claude / 'review').is_symlink())

    def test_corrupt_state_and_non_flat_source_fail_closed(self):
        self.make_skill(self.source / 'nested')
        with self.assertRaisesRegex(ValueError, 'Non-flat'):
            self.sync('--prune')
        self.manager.state_dir.mkdir(parents=True)
        self.manager.state_file.write_text('bad json')
        with self.assertRaises(ValueError):
            self.manager.inventory()

    def test_portable_links_modes_and_escape_rejection(self):
        src = self.make_skill(self.source)
        (src / 'run.sh').write_text('echo yes\n')
        (src / 'run.sh').chmod(0o755)
        (src / 'alias.sh').symlink_to('run.sh')
        self.sync('--apply')
        self.assertEqual((self.manager.root / 'review/run.sh').stat().st_mode & 0o777, 0o755)
        self.assertEqual(os.readlink(self.manager.root / 'review/alias.sh'), 'run.sh')
        (src / 'escape').symlink_to(self.base)
        with self.assertRaisesRegex(ValueError, 'Non-portable'):
            self.sync()

    def test_full_hash_detects_changes_with_same_mtime(self):
        src = self.make_skill(self.source)
        before = (src / 'SKILL.md').stat()
        old = skills.digest(src)
        (src / 'SKILL.md').write_text('different content')
        os.utime(src / 'SKILL.md', ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertNotEqual(skills.digest(src), old)

    def test_failure_rolls_back_files_and_state(self):
        src = self.make_skill(self.source)
        self.sync('--apply')
        before = self.manager.state_file.read_bytes()
        content = (self.manager.root / 'review/SKILL.md').read_bytes()
        (src / 'SKILL.md').write_text('new content')
        real_write = skills.write_json
        failed = False

        def injected(path, value):
            nonlocal failed
            if path == self.manager.state_file and not failed:
                failed = True
                raise OSError('simulated state write failure')
            real_write(path, value)
        with patch.object(skills, 'write_json', injected):
            with self.assertRaisesRegex(OSError, 'simulated'):
                self.sync('--apply')
        self.assertEqual(self.manager.state_file.read_bytes(), before)
        self.assertEqual((self.manager.root / 'review/SKILL.md').read_bytes(), content)
        self.assertFalse(list(self.manager.root.glob('.nodes-skills-*')))

    def test_source_overlap_and_scope_changes_rejected(self):
        src = self.make_skill(self.source)
        self.run_cmd('import', '--source', str(src), '--apply')
        self.assertTrue(self.sync('--adopt')['conflicts'])
        with self.assertRaisesRegex(ValueError, 'outside'):
            self.run_cmd('sync', '--source', str(self.manager.root))

    def test_case_collisions_and_owned_link_replacement_block_changes(self):
        self.make_skill(self.source, 'Review')
        self.make_skill(self.source, 'review')
        with self.assertRaisesRegex(ValueError, 'Case-insensitive'):
            self.sync('--apply')
        shutil.rmtree(self.source / 'Review')
        self.sync('--apply')
        (self.manager.claude / 'review').unlink()
        self.make_skill(self.manager.claude, body='local replacement')
        shutil.rmtree(self.source / 'review')
        result = self.sync('--prune', '--apply')
        self.assertTrue(result['conflicts'])
        self.assertTrue((self.manager.root / 'review').exists())

    def fake_paseo(self, upload_mode='ok'):
        """exec.sh runs commands locally; node.sh sdk-upload stores parts like the daemon does."""
        fake = self.base / 'fake-paseo/scripts'
        fake.mkdir(parents=True)
        self.uploads = self.base / 'paseo-home/uploads'
        (fake / 'exec.sh').write_text('#!' + sys.executable + '\nimport subprocess,sys\n'
                                      'sys.exit(subprocess.run(sys.argv[sys.argv.index("--")+1],shell=True).returncode)\n')
        (fake / 'node.sh').write_text('#!' + sys.executable + '''
import hashlib,json,sys,uuid
from pathlib import Path
data = Path(sys.argv[-1]).read_bytes()
uploads = Path(%r)
mode = %r
parts, size = [], -(-len(data) // 3)
for i in range(0, len(data), size):
    piece = data[i:i + size]
    folder = uploads / ('upload_' + uuid.uuid4().hex)
    folder.mkdir(parents=True)
    path = folder / ('nsm-test.part%%04d' %% len(parts))
    path.write_bytes(piece if not (mode == 'corrupt' and not parts) else piece[::-1] + b'x')
    parts.append({'path': str(path), 'size': len(piece), 'sha256': 'sha256:' + hashlib.sha256(piece).hexdigest()})
    print(json.dumps({'event': 'progress', 'bytes': i + len(piece), 'total_bytes': len(data)}), flush=True)
    if mode == 'fail' and len(parts) == 2:
        print(json.dumps({'event': 'error', 'error': 'connection lost', 'uploaded': [p['path'] for p in parts]}))
        sys.exit(1)
print(json.dumps({'event': 'result', 'sha256': 'sha256:' + hashlib.sha256(data).hexdigest(), 'size': len(data), 'parts': parts}))
''' % (str(self.uploads), upload_mode))
        for name in ('exec.sh', 'node.sh'):
            (fake / name).chmod(0o755)
        return fake.parent

    def large_source(self):
        src = self.make_skill(self.source)
        (src / 'asset.bin').write_bytes(b''.join(hashlib.sha256(str(i).encode()).digest() for i in range(1200)))
        return src

    def test_uploaded_transport_cleans_parts_and_reports_conflicts(self):
        src = self.large_source()
        paseo = self.fake_paseo()
        argv = ['--home', str(self.home), 'sync', '--source', str(self.source), '--apply']
        events = []
        result = node.run_remote('test', 'workspace', argv, paseo, progress=lambda phase, data: events.append(phase))
        self.assertEqual(result['exit_code'], 0)
        self.assertEqual(skills.digest(self.manager.root / 'review'), skills.digest(src))
        self.assertEqual(events.count('transferring'), 3)
        self.assertEqual(list(self.uploads.iterdir()), [])
        (self.manager.root / 'review/SKILL.md').write_text('edited on node')
        result = node.run_remote('test', 'workspace', argv, paseo)
        self.assertEqual(result['exit_code'], 2)
        self.assertTrue(result['result']['conflicts'])
        self.assertEqual(list(self.uploads.iterdir()), [])

    def test_corrupted_or_interrupted_upload_changes_nothing(self):
        self.large_source()
        argv = ['--home', str(self.home), 'sync', '--source', str(self.source), '--apply']
        for mode, message in (('corrupt', 'complete result'), ('fail', 'connection lost')):
            with self.subTest(mode):
                paseo = self.fake_paseo(mode)
                with self.assertRaisesRegex(RuntimeError, message):
                    node.run_remote('test', 'workspace', argv, paseo)
                self.assertEqual(list(self.uploads.iterdir()), [])
                self.assertFalse((self.manager.root / 'review').exists())
                shutil.rmtree(paseo)

    def test_transport_bootstrap_preserves_content_and_output(self):
        src = self.make_skill(self.source, body='中文 "$()" `echo hi`')
        (src / 'script.sh').write_text('echo ok')
        (src / 'script.sh').chmod(0o755)
        (src / 'link').symlink_to('script.sh')
        payload = {'script': Path(skills.__file__).read_text(),
                   'argv': ['--home', str(self.home), 'sync', '--source', str(self.source), '--apply'],
                   'files': node.pack_source(self.source)}
        program = node.inline_program(zlib.compress(json.dumps(payload).encode()))
        result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        data = json.loads(base64.b64decode(''.join(lines[1:-1])))
        self.assertTrue(data['result']['applied'])
        self.assertEqual(skills.digest(self.manager.root / 'review'), skills.digest(src))


if __name__ == '__main__':
    unittest.main()

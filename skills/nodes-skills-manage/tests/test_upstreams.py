import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import skills
import upstreams
from sources import Sources, scan
from controller import Controller

INDEX = 'https://skills.example.com/.well-known/agent-skills/index.json'


def skill_md(name, body='body'):
    return ('---\nname: ' + name + '\ndescription: test\n---\n' + body).encode()


def tar_gz(files, prefix=''):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for path, data in files.items():
            info = tarfile.TarInfo(prefix + path)
            info.size = len(data)
            info.mode = 0o755 if path.endswith('.sh') else 0o644
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


class Site:
    """In-memory HTTPS publisher following Agent Skills discovery v0.2.0."""
    def __init__(self):
        self.files = {}
        self.entries = []

    def publish(self, name, data, kind='archive', path=None):
        path = path or ('./' + name + ('.tar.gz' if kind == 'archive' else '/SKILL.md'))
        self.files[path.lstrip('./')] = data
        self.entries = [e for e in self.entries if e['name'] != name]
        self.entries.append({'name': name, 'type': kind, 'description': 'test', 'url': path, 'digest': sha(data)})

    def get(self, url, limit):
        if url == INDEX:
            return json.dumps({'$schema': upstreams.DISCOVERY_SCHEMA, 'skills': self.entries}).encode()
        return self.files[url[len(INDEX) - len('index.json'):]]


class WellKnownTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.site = Site()
        self.spec = {'id': 'vendor', 'type': 'well-known', 'url': INDEX, 'skills': ['suite']}

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self, pins=None, spec=None):
        into = self.root / ('out-' + str(len(list(self.root.iterdir()))))
        into.mkdir()
        return into, upstreams.fetch(spec or self.spec, into, pins, self.site.get)

    def test_archive_is_verified_and_extracted_with_modes(self):
        data = tar_gz({'SKILL.md': skill_md('suite'), 'references/a.md': b'a', 'scripts/run.sh': b'#!/bin/sh\n'})
        self.site.publish('suite', data)
        into, fetched = self.fetch()
        self.assertEqual(fetched, {'suite': sha(data)})
        self.assertEqual((into / 'suite/references/a.md').read_text(), 'a')
        self.assertTrue((into / 'suite/scripts/run.sh').stat().st_mode & 0o100)

    def test_single_top_level_directory_and_zip_and_skill_md(self):
        self.site.publish('suite', tar_gz({'SKILL.md': skill_md('suite')}, prefix='suite-1.0/'))
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('SKILL.md', skill_md('zipped'))
        self.site.publish('zipped', output.getvalue(), path='./zipped.zip')
        self.site.publish('single', skill_md('single'), kind='skill-md')
        into, fetched = self.fetch(spec={**self.spec, 'skills': '*'})
        self.assertEqual(sorted(fetched), ['single', 'suite', 'zipped'])
        self.assertEqual(sorted(p.name for p in into.iterdir()), ['single', 'suite', 'zipped'])

    def test_base_url_is_normalized_to_standard_index(self):
        spec = upstreams.normalize({'id': 'vendor', 'type': 'well-known', 'url': 'https://skills.example.com/'})
        self.assertEqual(spec['url'], INDEX)
        self.assertEqual(spec['skills'], '*')

    def test_digest_mismatch_and_changed_pin_are_rejected(self):
        self.site.publish('suite', tar_gz({'SKILL.md': skill_md('suite')}))
        self.site.files['suite.tar.gz'] = tar_gz({'SKILL.md': skill_md('suite', 'tampered')})
        with self.assertRaisesRegex(ValueError, 'digest 不一致'):
            self.fetch()
        self.site.publish('suite', tar_gz({'SKILL.md': skill_md('suite')}))
        with self.assertRaisesRegex(ValueError, '已在检查后变化'):
            self.fetch(pins={'suite': 'sha256:' + '0' * 64})

    def test_unsafe_archives_are_rejected(self):
        cases = {'path': tar_gz({'../escape.md': b'x', 'SKILL.md': skill_md('suite')}),
                 'name': tar_gz({'SKILL.md': skill_md('other')}),
                 'layout': tar_gz({'a/SKILL.md': skill_md('suite'), 'b/x.md': b'x'})}
        link = io.BytesIO()
        with tarfile.open(fileobj=link, mode='w:gz') as archive:
            info = tarfile.TarInfo('SKILL.md')
            info.type = tarfile.SYMTYPE
            info.linkname = '/etc/passwd'
            archive.addfile(info)
        cases['link'] = link.getvalue()
        for label, data in cases.items():
            with self.subTest(label):
                self.site.publish('suite', data)
                with self.assertRaises(ValueError):
                    self.fetch()

    def test_index_must_declare_discovery_schema(self):
        self.site.get = lambda url, limit: json.dumps({'skills': []}).encode()
        with self.assertRaisesRegex(ValueError, r'\$schema'):
            self.fetch()

    def test_invalid_specs(self):
        for spec in [{'id': 'Bad', 'type': 'git', 'url': 'https://example.com/r.git'},
                     {'id': 'x', 'type': 'svn', 'url': 'https://example.com'},
                     {'id': 'x', 'type': 'well-known', 'url': 'http://example.com'},
                     {'id': 'x', 'type': 'git', 'url': 'https://example.com/r.git', 'path': '../up'},
                     {'id': 'x', 'type': 'git', 'url': 'https://example.com/r.git', 'extra': 1},
                     {'id': 'x', 'type': 'well-known', 'url': INDEX, 'skills': []}]:
            with self.subTest(spec=spec):
                with self.assertRaises(ValueError):
                    upstreams.normalize(spec)


class MultiSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        (self.repo / 'skills/review').mkdir(parents=True)
        (self.repo / 'skills/review/SKILL.md').write_bytes(skill_md('review'))
        for args in (['init', '--quiet'], ['add', '.'],
                     ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'x']):
            subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True)
        self.site = Site()
        self.site.publish('suite', tar_gz({'SKILL.md': skill_md('suite')}))
        self.base = self.root / 'data'
        (self.base / 'empty').mkdir(parents=True)
        skills.write_json(self.base / 'source.json', {
            'version': 2,
            'sources': [{'id': 'team', 'type': 'git', 'url': str(self.repo), 'path': 'skills'}],
            'snapshot': {'directory': 'empty', 'prepared_at': 'initial', 'skills': {}}})
        self.sources = Sources(self.base, download=self.site.get)
        self.controller = Controller(self.root, self.base, gateway=object())
        self.controller.sources = self.sources

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_source_then_update_merges_both_sources(self):
        added = self.controller.execute('add-source', {'source': {
            'id': 'vendor', 'type': 'well-known', 'url': 'https://skills.example.com', 'skills': ['suite']}})
        self.assertEqual(added['skills'], ['suite'])
        preview = self.sources.check()
        self.assertEqual({c['name']: (c['kind'], c['source']) for c in preview['changes']},
                         {'review': ('added', 'team'), 'suite': ('added', 'vendor')})
        result = self.sources.apply(preview)
        self.assertEqual({s['id']: s['installed'] for s in result['source']['sources']},
                         {'team': ['review'], 'vendor': ['suite']})
        self.assertNotIn('commit', result['source'])

    def test_upstream_change_after_review_blocks_apply(self):
        self.controller.execute('add-source', {'source': {'id': 'vendor', 'type': 'well-known', 'url': INDEX}})
        preview = self.sources.check()
        self.site.publish('suite', tar_gz({'SKILL.md': skill_md('suite', 'newer')}))
        with self.assertRaisesRegex(ValueError, '变化'):
            self.sources.apply(preview)
        self.assertEqual(self.sources.current()[0]['snapshot']['skills'], {})

    def test_duplicate_names_and_ids_are_rejected(self):
        self.site.publish('review', tar_gz({'SKILL.md': skill_md('review')}))
        self.controller.execute('add-source', {'source': {'id': 'vendor', 'type': 'well-known', 'url': INDEX}})
        with self.assertRaisesRegex(ValueError, '技能重名'):
            self.sources.check()
        with self.assertRaisesRegex(ValueError, 'id 已存在'):
            self.controller.execute('add-source', {'source': {'id': 'vendor', 'type': 'well-known', 'url': INDEX}})

    def test_remove_source_withdraws_its_skills_on_next_update(self):
        self.controller.execute('add-source', {'source': {'id': 'vendor', 'type': 'well-known', 'url': INDEX}})
        self.sources.apply(self.sources.check())
        self.controller.execute('remove-source', {'id': 'vendor'})
        self.assertIn('suite', self.sources.current()[0]['snapshot']['skills'])
        preview = self.sources.check()
        self.assertEqual([(c['name'], c['kind']) for c in preview['changes']], [('suite', 'removed')])
        self.sources.apply(preview)
        config, root = self.sources.current()
        self.assertEqual(set(config['snapshot']['skills']), {'review'})
        self.assertEqual(scan(root), {'review': {'digest': config['snapshot']['skills']['review']['digest']}})

    def test_git_root_with_other_directories_needs_path_or_list(self):
        (self.repo / 'docs').mkdir()
        (self.repo / 'docs/readme.md').write_text('x')
        with self.assertRaisesRegex(ValueError, '非技能子目录'):
            upstreams.fetch({'id': 'root', 'type': 'git', 'url': str(self.repo)}, self.root / 'out-a')
        (self.root / 'out-b').mkdir()
        fetched = upstreams.fetch({'id': 'root', 'type': 'git', 'url': str(self.repo), 'path': 'skills',
                                   'skills': ['review']}, self.root / 'out-b')
        self.assertEqual(list(fetched), ['review'])


if __name__ == '__main__':
    unittest.main()

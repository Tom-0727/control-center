"""Controller snapshot operations; no agent or UI-specific rules."""
import contextlib
import copy
import difflib
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone

import skills
import node
import upstreams


def now():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def revision(records):
    """Combined version of a skill set: changes whenever any content or upstream revision changes."""
    return fingerprint({n: [r['source'], r['revision'], r['digest']] for n, r in records.items()})


def scan(root):
    if root.is_symlink():
        raise ValueError('技能源不能是软链接')
    found = skills.discover(root)
    for name, path in found.items():
        skills.valid_name(name)
        if path.is_symlink():
            raise ValueError('技能实体目录不能是软链接: ' + name)
    if len({n.casefold() for n in found}) != len(found):
        raise ValueError('技能名称存在大小写冲突')
    node.pack_source(root)
    return {n: {'digest': skills.digest(p)} for n, p in found.items()}


class Sources:
    def __init__(self, base, download=None):
        self.base = Path(base).resolve()
        self.file = self.base / 'source.json'
        self.download = download

    def load(self):
        config = json.loads(self.file.read_text())
        if config.get('version') != 2 or not isinstance(config.get('sources'), list):
            raise ValueError('source.json 须为 version 2 的来源列表格式，见 references/common-source.md')
        specs = [upstreams.normalize(s) for s in config['sources']]
        if len({s['id'] for s in specs}) != len(specs):
            raise ValueError('source.json 中存在重复的来源 id')
        return config, specs

    def current(self):
        config, specs = self.load()
        root = (self.base / config['snapshot']['directory']).resolve()
        if self.base not in root.parents:
            raise ValueError('快照目录必须位于控制中心数据目录内')
        actual = scan(root)
        expected = {n: {'digest': row['digest']} for n, row in config['snapshot']['skills'].items()}
        if actual != expected:
            raise ValueError('控制中心快照有未登记修改，请先保留并处理这些修改')
        return config, root

    def summary(self):
        config, root = self.current()
        specs = upstreams_of(config)
        records = config['snapshot']['skills']
        return {'sources': [{**s, 'installed': sorted(n for n, r in records.items() if r['source'] == s['id'])}
                            for s in specs],
                'revision': revision(records), 'prepared_at': config['snapshot']['prepared_at'],
                'fingerprint': fingerprint(config), 'skills': self.entries(config, root)}

    def entries(self, config, root):
        rows = []
        for name, record in sorted(config['snapshot']['skills'].items()):
            body = (root / name / 'SKILL.md').read_text()
            match = re.search(r'^description:\s*(.+)$', body, re.M)
            rows.append({'name': name, 'digest': record['digest'], 'revision': record['revision'],
                         'description': match.group(1).strip('\"\'') if match else '',
                         'source': record['source']})
        return rows

    def detail(self, name):
        skills.valid_name(name)
        config, root = self.current()
        if name not in config['snapshot']['skills']:
            raise ValueError('未知公共技能')
        return {'name': name, 'body': (root / name / 'SKILL.md').read_text()}

    @contextlib.contextmanager
    def candidate(self, config, pins=None):
        """Fetch every source into one flat directory; `pins` are reviewed preview records."""
        with tempfile.TemporaryDirectory(prefix='nodes-skills-source-') as tmp:
            merged = Path(tmp) / 'skills'
            merged.mkdir()
            records = {}
            for spec in upstreams_of(config):
                staging = Path(tmp) / 'sources' / spec['id']
                staging.mkdir(parents=True)
                source_pins = None if pins is None else {
                    n: r['revision'] for n, r in pins.items() if r.get('source') == spec['id']}
                fetched = upstreams.fetch(spec, staging, source_pins, self.download)
                for name, upstream in sorted(fetched.items()):
                    if name.casefold() in {n.casefold() for n in records}:
                        other = next(r['source'] for n, r in records.items() if n.casefold() == name.casefold())
                        raise ValueError('技能重名: ' + name + ' 同时来自 ' + other + ' 和 ' + spec['id'])
                    shutil.copytree(staging / name, merged / name, symlinks=True)
                    records[name] = {'digest': skills.digest(merged / name), 'source': spec['id'],
                                     'revision': upstream}
            scan(merged)
            yield merged, records

    def check(self):
        config, current = self.current()
        with self.candidate(config) as (candidate, records):
            changes = []
            old = config['snapshot']['skills']
            for name in sorted(set(old) | set(records)):
                if old.get(name, {}).get('digest') == records.get(name, {}).get('digest'):
                    continue
                kind = 'added' if name not in old else 'removed' if name not in records else 'modified'
                left = current / name
                right = candidate / name
                files = []
                names = set(p.relative_to(left).as_posix() for p in left.rglob('*') if p.is_file()) if left.exists() else set()
                names |= set(p.relative_to(right).as_posix() for p in right.rglob('*') if p.is_file()) if right.exists() else set()
                for rel in sorted(names):
                    a, b = left / rel, right / rel
                    before = a.read_bytes() if a.is_file() else b''
                    after = b.read_bytes() if b.is_file() else b''
                    if before == after and a.exists() == b.exists():
                        continue
                    try:
                        diff = ''.join(difflib.unified_diff(before.decode().splitlines(True), after.decode().splitlines(True),
                                                            fromfile='旧/' + rel, tofile='新/' + rel))
                    except UnicodeDecodeError:
                        diff = '二进制文件内容发生变化'
                    files.append({'path': rel, 'diff': diff[:12000], 'truncated': len(diff) > 12000})
                changes.append({'name': name, 'kind': kind, 'source': (records.get(name) or old[name])['source'],
                                'files': files})
            return {'base_fingerprint': fingerprint(config), 'revision': revision(records),
                    'skills': records, 'changes': changes, 'checked_at': now()}

    def apply(self, preview):
        config, current = self.current()
        if fingerprint(config) != preview['base_fingerprint']:
            raise ValueError('来源配置或快照已变化，请重新检查更新')
        reviewed = preview.get('skills')
        if not isinstance(reviewed, dict) or not all(
                isinstance(r, dict) and {'digest', 'source', 'revision'} <= set(r) for r in reviewed.values()):
            raise ValueError('无效的更新预览')
        with self.candidate(config, reviewed) as (candidate, records):
            if records != reviewed:
                raise ValueError('候选内容变化，请重新检查更新')
            if fingerprint(self.current()[0]) != preview['base_fingerprint']:
                raise ValueError('来源配置已变化，请重新检查更新')
            if records == config['snapshot']['skills']:
                return {'changed': False, 'source': self.summary()}
            destination = self.base / 'versions' / (revision(records)[:12] + '-' + uuid.uuid4().hex[:12])
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copytree(candidate, destination, symlinks=True)
                if scan(destination) != {n: {'digest': r['digest']} for n, r in records.items()}:
                    raise ValueError('新快照校验失败')
                updated = copy.deepcopy(config)
                updated['snapshot'] = {'directory': str(destination.relative_to(self.base)),
                                       'prepared_at': now(), 'skills': records}
                skills.write_json(self.file, updated)
            except Exception:
                shutil.rmtree(destination, ignore_errors=True)
                raise
        return {'changed': True, 'source': self.summary()}

    def add(self, spec):
        """Register a source after probing it; its skills enter the snapshot on the next update."""
        config, specs = self.load()
        spec = upstreams.normalize(spec)
        if spec['id'] in {s['id'] for s in specs}:
            raise ValueError('来源 id 已存在: ' + spec['id'])
        with tempfile.TemporaryDirectory(prefix='nodes-skills-probe-') as tmp:
            fetched = upstreams.fetch(spec, Path(tmp), None, self.download)
        if not fetched:
            raise ValueError('来源中没有找到技能')
        taken = {n.casefold(): r['source'] for n, r in config['snapshot']['skills'].items()
                 if r['source'] in {s['id'] for s in specs}}
        clashes = sorted(n for n in fetched if n.casefold() in taken)
        if clashes:
            raise ValueError('技能重名: ' + ', '.join(clashes) + ' 已由其他来源提供')
        updated = copy.deepcopy(config)
        updated['sources'].append(spec)
        skills.write_json(self.file, updated)
        return {'added': spec, 'skills': sorted(fetched), 'source': self.summary()}

    def remove(self, source_id):
        """Unregister a source; its skills leave the snapshot on the next update and nodes on the next sync."""
        config, specs = self.load()
        if source_id not in {s['id'] for s in specs}:
            raise ValueError('未知来源: ' + str(source_id))
        updated = copy.deepcopy(config)
        updated['sources'] = [s for s in config['sources'] if s.get('id') != source_id]
        skills.write_json(self.file, updated)
        return {'removed': source_id, 'source': self.summary()}


def upstreams_of(config):
    return [upstreams.normalize(s) for s in config['sources']]

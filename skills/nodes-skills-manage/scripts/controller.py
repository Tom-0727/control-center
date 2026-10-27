#!/usr/bin/env python3
"""Shared CLI/UI orchestration. JSON input on stdin; NDJSON progress and result."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
import skills
import node
from sources import Sources, fingerprint, now, scan

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_LOCK = threading.Lock()


def emit(event, **fields):
    with OUTPUT_LOCK:
        print(json.dumps({'event': event, **fields}, ensure_ascii=False), flush=True)


class Gateway:
    def __init__(self, root):
        self.paseo = Path(root) / 'skills/paseo-nodes-use'

    def command(self, *args):
        run = subprocess.run([str(self.paseo / 'scripts/node.sh'), *args],
                             capture_output=True, text=True, timeout=65)
        if run.returncode:
            raise RuntimeError(run.stderr[-1800:] or run.stdout[-1800:])
        return run.stdout

    def nodes(self):
        rows = []
        for line in self.command('list').splitlines():
            name, identity, *aliases = line.split('\t')
            rows.append({'id': identity, 'name': name})
        return rows

    def workspaces(self, target):
        return json.loads(self.command(target['name'], 'workspace', 'ls', '--json'))

    def run(self, target, workspace, argv, progress):
        return node.run_remote(target['name'], workspace, argv, self.paseo, progress=progress)


def link_matches(row, root, canonical, digest):
    return (row and row.get('kind') == 'link' and not row.get('broken')
            and row.get('digest') == digest
            and os.path.normpath(os.path.join(root['path'], row.get('target', ''))) == canonical)


def compare(config, inventory):
    roots = inventory['roots']
    shared = {s['name']: s for s in roots['shared']['skills']}
    claude = {s['name']: s for s in roots['claude']['skills']}
    legacy = {s['name']: s for s in roots['codex_legacy']['skills']}
    expected = config['snapshot']['skills']
    rows = []
    for name, expected_row in sorted(expected.items()):
        actual = shared.get(name)
        status = 'missing'
        if actual:
            if actual.get('error') or actual.get('kind') != 'directory':
                status = 'conflict'
            elif actual.get('scope') == 'local' or actual.get('modified'):
                status = 'modified_locally'
            elif actual.get('digest') != expected_row['digest']:
                status = 'update_available' if actual.get('scope') == 'common' else 'conflict'
            elif actual.get('scope') != 'common':
                status = 'needs_registration'
            else:
                status = 'consistent'
        if status == 'consistent':
            canonical = actual['path']
            if inventory.get('claude_configured'):
                root = roots['claude']
                # A whole Claude root linked to the canonical root is supported.
                same_root = root.get('symlink') and root.get('resolved_path') == roots['shared']['resolved_path']
                if not same_root and not link_matches(claude.get(name), root, canonical, expected_row['digest']):
                    status = 'link_issue'
                elif same_root and claude.get(name, {}).get('digest') != expected_row['digest']:
                    status = 'link_issue'
            if name in legacy and not link_matches(legacy[name], roots['codex_legacy'], canonical, expected_row['digest']):
                status = 'link_issue'
        rows.append({'name': name, 'status': status})
    for name, record in sorted(inventory.get('managed', {}).items()):
        if record['scope'] == 'common' and name not in expected:
            rows.append({'name': name, 'status': 'withdrawn'})
    extras = []
    for root, details in roots.items():
        if root == 'claude':
            continue
        for row in details['skills']:
            if row['skill'] and row['name'] not in expected and inventory.get('managed', {}).get(row['name'], {}).get('scope') != 'common':
                extras.append({'name': row['name'], 'path': row['path'], 'scope': row['scope']})
    return {'skills': rows, 'node_skills': extras, 'consistent': all(r['status'] == 'consistent' for r in rows)}


STATUS_FIELDS = ('status', 'consistent', 'skills', 'node_skills', 'error', 'workspace', 'workspaces', 'checked_at')


def snapshot_key(config):
    """Node verdicts depend on the snapshot only; editing the source list keeps them valid."""
    return fingerprint(config['snapshot'])


class NodeStatus:
    """Last observed state of each node, shared by agent and GUI runs."""
    def __init__(self, base):
        self.file = Path(base) / 'nodes-status.json'
        self.lock = Path(base) / 'nodes-status.lock'

    def load(self):
        try:
            saved = json.loads(self.file.read_text())
        except (FileNotFoundError, ValueError):
            return {}  # A missing or damaged cache is rebuilt by the next check.
        return saved if isinstance(saved, dict) else {}

    def record(self, rows, snapshot):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        with self.lock.open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            saved = self.load()
            for row in rows:
                saved[row['id']] = {**{k: row[k] for k in STATUS_FIELDS if k in row}, 'snapshot': snapshot}
            skills.write_json(self.file, saved)

    def merge(self, targets, snapshot):
        saved = self.load()
        rows = []
        for target in targets:
            last = saved.get(target['id'])
            if not last:
                rows.append(target)
            elif last.get('snapshot') == snapshot:
                rows.append({**target, **{k: v for k, v in last.items() if k != 'snapshot'}})
            else:
                # Checked against an earlier snapshot: per-skill verdicts no longer apply.
                rows.append({**target, 'stale': True, 'checked_at': last.get('checked_at'),
                             'node_skills': last.get('node_skills'), 'workspaces': last.get('workspaces')})
        return rows


class Controller:
    def __init__(self, root=ROOT, data_dir=None, gateway=None, progress=None):
        self.root = Path(root)
        self.sources = Sources(data_dir or self.root / '.private/nodes-skills-manage')
        self.status = NodeStatus(self.sources.base)
        self.gateway = gateway or Gateway(self.root)
        self.progress = progress or (lambda **fields: None)

    @contextlib.contextmanager
    def writing(self):
        self.sources.base.mkdir(parents=True, exist_ok=True)
        with (self.sources.base / 'operation.lock').open('a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('控制中心已有写任务，请等待完成后重试')
            yield

    def targets(self, ids=None):
        registered = self.gateway.nodes()
        if ids is None:
            return registered
        if not ids or len(ids) != len(set(ids)) or set(ids) - {n['id'] for n in registered}:
            raise ValueError('请选择有效且不重复的目标节点')
        return [n for n in registered if n['id'] in ids]

    def workspace(self, target, choices):
        available = self.gateway.workspaces(target)
        selected = choices.get(target['id'])
        if selected:
            if selected not in {w['workspaceId'] for w in available}:
                raise ValueError('所选工作区已不存在')
            return selected, available
        matches = [w for w in available if re.search(r'环境|运维|environment|maintenance', w.get('name', ''), re.I)]
        if len(matches) == 1:
            return matches[0]['workspaceId'], available
        if len(available) == 1:
            return available[0]['workspaceId'], available
        return None, available

    def run(self, target, workspace, args):
        def progress(phase, data):
            self.progress(node_id=target['id'], phase=phase, **data)
        result = self.gateway.run(target, workspace, args, progress)
        if result['exit_code'] not in (0, 2) or 'error' in result['result']:
            raise RuntimeError(result['result'].get('error', '节点命令失败'))
        return result['result']

    def parallel(self, targets, operation):
        completed = {}
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {executor.submit(operation, target): target for target in targets}
            for future in as_completed(futures):
                target = futures[future]
                try:
                    completed[target['id']] = future.result()
                except Exception as error:
                    completed[target['id']] = {**target, 'status': 'error', 'error': str(error), 'checked_at': now()}
                self.progress(node_id=target['id'], phase='finished', result=completed[target['id']])
        return [completed[t['id']] for t in targets]

    def check(self, config, target, choices):
        self.progress(node_id=target['id'], phase='checking')
        workspace, available = self.workspace(target, choices)
        row = {**target, 'workspace': workspace, 'workspaces': available, 'checked_at': now()}
        if not workspace:
            return {**row, 'status': 'needs_workspace', 'error': '请为此节点选择一个现有工作区'}
        inventory = self.run(target, workspace, ['inventory'])
        return {**row, 'status': 'ready', 'inventory': inventory, **compare(config, inventory)}

    def inspect(self, request):
        config, _ = self.sources.current()
        choices = request.get('workspaces', {})
        rows = self.parallel(self.targets(request.get('node_ids')), lambda target: self.check(config, target, choices))
        if fingerprint(self.sources.current()[0]) != fingerprint(config):
            raise ValueError('盘点期间来源已变化，请重新扫描')
        self.status.record(rows, snapshot_key(config))
        return {'source': self.sources.summary(), 'nodes': rows, 'checked_at': now()}

    def sync(self, request):
        with self.writing():
            config, source = self.sources.current()
            targets = self.targets(request.get('node_ids'))
            choices = request.get('workspaces', {})
            with tempfile.TemporaryDirectory(prefix='nodes-skills-frozen-') as tmp:
                # Every node receives the same content even if the snapshot directory is touched meanwhile.
                frozen = Path(tmp) / 'source'
                shutil.copytree(source, frozen, symlinks=True)
                if scan(frozen) != {n: {'digest': row['digest']} for n, row in config['snapshot']['skills'].items()}:
                    raise ValueError('技能库内容与登记不一致，请先检查更新')
                def sync_node(target):
                    row = self.check(config, target, choices)
                    if row['status'] != 'ready':
                        return row
                    if row['consistent']:
                        return {**row, 'status': 'verified', 'no_op': True}
                    # The node recomputes the plan under its own lock; any conflict leaves it untouched.
                    applied = self.run(target, row['workspace'], ['sync', '--source', str(frozen), '--adopt', '--prune', '--apply'])
                    if applied['conflicts']:
                        return {**row, 'status': 'conflict', 'plan': applied, 'error': '节点上有本地修改或同名内容，已跳过此节点'}
                    self.progress(node_id=target['id'], phase='verifying')
                    actual = self.run(target, row['workspace'], ['inventory'])
                    comparison = compare(config, actual)
                    return {**row, 'status': 'verified' if comparison['consistent'] else 'verification_failed',
                            'plan': applied, 'inventory': actual, 'checked_at': now(), **comparison}
                rows = self.parallel(targets, sync_node)
            self.status.record(rows, snapshot_key(config))
            return {'source': self.sources.summary(), 'nodes': rows,
                    'complete': all(n['status'] == 'verified' for n in rows), 'checked_at': now()}

    def execute(self, action, request):
        if action == 'overview':
            return {'source': self.sources.summary(),
                    'nodes': self.status.merge(self.targets(), snapshot_key(self.sources.current()[0]))}
        if action == 'skill-detail':
            return self.sources.detail(request['name'])
        if action == 'refresh':
            return self.inspect(request)
        if action == 'check-update':
            return self.sources.check()
        if action == 'apply-update':
            with self.writing():
                return self.sources.apply(request['preview'])
        if action == 'add-source':
            with self.writing():
                return self.sources.add(request.get('source'))
        if action == 'remove-source':
            with self.writing():
                return self.sources.remove(request.get('id'))
        if action == 'sync':
            return self.sync(request)
        raise ValueError('未知操作')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['overview', 'skill-detail', 'refresh', 'check-update',
                                         'apply-update', 'add-source', 'remove-source', 'sync'])
    parser.add_argument('--data-dir', type=Path, help='Use isolated controller data for tests')
    args = parser.parse_args()
    try:
        request = json.loads(sys.stdin.read() or '{}') if not sys.stdin.isatty() else {}
        if not isinstance(request, dict):
            raise ValueError('输入必须为 JSON 对象')
        controller = Controller(data_dir=args.data_dir, progress=lambda **fields: emit('progress', **fields))
        emit('result', result=controller.execute(args.action, request))
        return 0
    except Exception as error:
        emit('error', error=str(error))
        return 1


if __name__ == '__main__':
    sys.exit(main())

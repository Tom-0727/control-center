#!/usr/bin/env python3
"""Dependency-free skill directory manager (Python 3.9+, Linux/macOS)."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import uuid

IGNORED = {'.git', '__pycache__', '.DS_Store'}


def exists(path):
    return os.path.lexists(path)


def valid_name(name):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}', name) or name.lower() in {'synced', 'anthropic-skills'}:
        raise ValueError('Unsupported skill directory name: ' + name)
    return name


def tree(path):
    """Hash portable entries, rejecting external symlinks and special files."""
    root = path.resolve(strict=True)
    if not (root / 'SKILL.md').is_file():
        raise ValueError('Missing SKILL.md: ' + str(path))
    entries = []

    def walk(folder):
        for p in sorted(folder.iterdir()):
            if p.name in IGNORED:
                continue
            rel = p.relative_to(root).as_posix()
            mode = p.lstat().st_mode
            if p.is_symlink():
                dest = os.readlink(p)
                resolved = p.resolve(strict=True)
                if os.path.isabs(dest) or root not in resolved.parents:
                    raise ValueError('Non-portable symlink: ' + str(p))
                entries.append((rel, 'link', dest, 0))
            elif p.is_dir():
                entries.append((rel, 'dir', '', 0))
                walk(p)
            elif stat.S_ISREG(mode):
                entries.append((rel, 'file', hashlib.sha256(p.read_bytes()).hexdigest(), mode & 0o111))
            else:
                raise ValueError('Special file in skill: ' + str(p))
    walk(root)
    return entries


def digest(path):
    data = json.dumps(tree(path), ensure_ascii=True, separators=(',', ':'))
    return hashlib.sha256(data.encode()).hexdigest()


def discover(root):
    if not root.is_dir():
        return {}
    return {p.name: p for p in sorted(root.iterdir())
            if not p.name.startswith('.') and (p / 'SKILL.md').is_file()}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(tmp, path)
    finally:
        if exists(tmp):
            tmp.unlink()


def discard(path):
    if path.is_symlink():
        path.unlink()
    elif exists(path):
        shutil.rmtree(path)


def copy_entry(src, dest):
    if src.is_symlink():
        dest.symlink_to(os.readlink(src))
    else:
        shutil.copytree(src, dest, symlinks=True)


class Manager:
    def __init__(self, home=None):
        self.home = Path(home).expanduser().resolve() if home else Path.home()
        self.root = self.home / '.agents/skills'
        self.claude = (Path(os.environ.get('CLAUDE_CONFIG_DIR', str(self.home / '.claude'))).expanduser()
                       if home is None else self.home / '.claude') / 'skills'
        self.codex = (Path(os.environ.get('CODEX_HOME', str(self.home / '.codex'))).expanduser()
                      if home is None else self.home / '.codex') / 'skills'
        self.state_dir = self.home / '.local/state/nodes-skills-manage'
        self.state_file = self.state_dir / 'state.json'

    def state(self):
        if not exists(self.state_file):
            return {'version': 1, 'managed': {}, 'links': {}}
        data = json.loads(self.state_file.read_text(encoding='utf-8'))
        if data.get('version') != 1 or not isinstance(data.get('managed'), dict) or not isinstance(data.get('links'), dict):
            raise ValueError('Invalid state; restore state.json from a backup before writing')
        for name, record in data['managed'].items():
            valid_name(name)
            if record.get('scope') not in {'common', 'local'} or not re.fullmatch('[0-9a-f]{64}', record.get('digest', '')):
                raise ValueError('Invalid managed record: ' + name)
        return data

    def inventory(self):
        state = self.state()
        roots = {}
        for key, root in [('shared', self.root), ('claude', self.claude), ('codex_legacy', self.codex)]:
            rows = []
            if root.is_dir():
                for p in sorted(root.iterdir()):
                    if p.name.startswith('.'):
                        continue
                    row = {'name': p.name, 'path': str(p), 'kind': 'link' if p.is_symlink() else 'directory' if p.is_dir() else 'file'}
                    if p.is_symlink():
                        row.update(target=os.readlink(p), broken=not p.exists())
                    row['skill'] = (p / 'SKILL.md').is_file()
                    record = state['managed'].get(p.name) if key == 'shared' else None
                    row['scope'] = record['scope'] if record else 'unmanaged'
                    if row['skill']:
                        try:
                            row['digest'] = digest(p)
                            if record:
                                row['modified'] = row['digest'] != record['digest']
                        except (OSError, ValueError, RuntimeError) as e:
                            row['error'] = str(e)
                    rows.append(row)
            roots[key] = {'path': str(root), 'resolved_path': str(root.resolve()),
                          'exists': root.exists(), 'symlink': root.is_symlink(), 'skills': rows}
        missing = [n for n in state['managed'] if not exists(self.root / n)]
        return {'roots': roots, 'missing_managed': missing, 'state_file': str(self.state_file),
                'managed': state['managed'], 'claude_configured': self.claude.parent.is_dir()}

    def plan(self, args):
        before = self.state()
        after = copy.deepcopy(before)
        actions, conflicts = [], []
        desired = discover(self.root)
        incoming, removed, obsolete = {}, set(), set()
        if self.root.is_symlink():
            raise ValueError('Shared root is a symlink; inspect its ownership before migrating')
        if exists(self.root) and not self.root.is_dir():
            raise ValueError('Shared root is not a directory')
        if args.command in {'sync', 'import'}:
            source = Path(args.source).expanduser().resolve(strict=True)
            if source == self.root.resolve() or self.root.resolve() in source.parents or source in self.root.resolve().parents:
                raise ValueError('Source must be outside the destination skills directory')
            if args.command == 'sync':
                if not source.is_dir() or (source / 'SKILL.md').exists():
                    raise ValueError('sync --source must contain skill directories')
                incoming = discover(source)
                unexpected = [p.name for p in source.iterdir() if p.is_dir() and not p.name.startswith('.') and p.name not in incoming]
                if unexpected:
                    raise ValueError('Non-flat or invalid skill directories: ' + ', '.join(unexpected))
            else:
                incoming = {valid_name(source.name): source}
            names = set(desired) | set(incoming)
            if len({n.casefold() for n in names}) != len(names):
                raise ValueError('Case-insensitive name collision; source must also work on macOS')
            for name, src in incoming.items():
                valid_name(name)
                new_hash = digest(src)
                dest = self.root / name
                record = before['managed'].get(name)
                scope = 'common' if args.command == 'sync' else 'local'
                if record and record['scope'] != scope:
                    conflicts.append({'name': name, 'reason': 'scope conflict: ' + record['scope']})
                    continue
                if dest.is_symlink():
                    conflicts.append({'name': name, 'reason': 'shared entry is an external symlink'})
                    continue
                if exists(dest):
                    current = digest(dest)
                    if record and current != record['digest']:
                        conflicts.append({'name': name, 'reason': 'modified on node'})
                        continue
                    if not record and (current != new_hash or (scope == 'common' and not args.adopt)):
                        conflicts.append({'name': name, 'reason': 'unmanaged name collision; identical common content requires --adopt'})
                        continue
                    if current != new_hash:
                        actions.append({'op': 'copy', 'path': str(dest), 'source': str(src), 'digest': new_hash})
                else:
                    actions.append({'op': 'copy', 'path': str(dest), 'source': str(src), 'digest': new_hash})
                after['managed'][name] = {'scope': scope, 'digest': new_hash}
                desired[name] = src
            if args.command == 'sync':
                obsolete = {n for n, v in before['managed'].items() if v['scope'] == 'common'} - set(incoming)
                if args.prune:
                    removed = obsolete
        elif args.command == 'remove':
            name = valid_name(args.name)
            record = before['managed'].get(name)
            if not record or record['scope'] != 'local':
                raise ValueError('remove accepts managed local skills only; remove common skills from source and sync --prune')
            removed = {name}

        for name in sorted(removed):
            dest = self.root / name
            if exists(dest):
                if dest.is_symlink() or digest(dest) != before['managed'][name]['digest']:
                    conflicts.append({'name': name, 'reason': 'modified on node; cannot remove'})
                    continue
                actions.append({'op': 'remove', 'path': str(dest)})
            after['managed'].pop(name, None)
            desired.pop(name, None)

        # Create Claude links only once Claude has a configuration directory.
        # Reconcile existing legacy Codex entries without creating duplicates.
        for name, src in sorted(desired.items()):
            valid_name(name)
            canonical = self.root / name
            targets = [self.claude] if self.claude.parent.is_dir() else []
            if exists(self.codex / name):
                targets.append(self.codex)
            for root in targets:
                if root.resolve() == self.root.resolve():
                    continue
                if root.is_symlink() or (exists(root) and not root.is_dir()):
                    conflicts.append({'path': str(root), 'reason': 'target root requires explicit migration'})
                    continue
                dest = root / name
                if dest.is_symlink() and dest.resolve() == canonical.resolve():
                    after['links'][str(dest)] = str(canonical)
                    continue
                if exists(dest):
                    if dest.is_symlink() or digest(dest) != digest(src):
                        conflicts.append({'path': str(dest), 'reason': 'different existing skill or external link'})
                        continue
                actions.append({'op': 'link', 'path': str(dest), 'target': str(canonical)})
                after['links'][str(dest)] = str(canonical)

        for path, target in list(before['links'].items()):
            p = Path(path)
            if p.parent not in {self.claude, self.codex} or target != str(self.root / p.name):
                raise ValueError('Invalid or changed target in state: ' + path)
            if p.name not in removed:
                continue
            if exists(p):
                if not p.is_symlink() or p.resolve() != Path(target).resolve():
                    conflicts.append({'path': path, 'reason': 'managed link replaced locally'})
                    continue
                actions.append({'op': 'remove', 'path': path})
            after['links'].pop(path, None)
        plan = {'actions': actions, 'conflicts': conflicts, 'retained_common': sorted(obsolete - removed),
                'state_changed': before != after,
                'adoptions': sorted(n for n in incoming if n not in before['managed']
                                    and n in after['managed'] and exists(self.root / n))}
        return plan, before, after

    def apply(self, args):
        if not args.apply:
            plan, _, _ = self.plan(args)
            return dict(plan, applied=False)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        with (self.state_dir / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            plan, before, after = self.plan(args)
            if plan['conflicts'] or (not plan['actions'] and not plan['state_changed']):
                return dict(plan, applied=False)
            backup = self.state_dir / 'backups' / uuid.uuid4().hex
            backup.mkdir(parents=True)
            write_json(backup / 'state-before.json', before)
            write_json(backup / 'plan.json', plan)
            completed, staging = [], []
            try:
                for i, action in enumerate(plan['actions']):
                    dest = Path(action['path'])
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    staged = None
                    if action['op'] == 'copy':
                        work = Path(tempfile.mkdtemp(prefix='.nodes-skills-', dir=dest.parent))
                        staging.append(work)
                        staged = work / 'skill'
                        shutil.copytree(action['source'], staged, symlinks=True, ignore=shutil.ignore_patterns(*IGNORED))
                        if digest(staged) != action['digest']:
                            raise ValueError('Source changed while copying: ' + action['source'])
                    saved = backup / str(i)
                    had_old = exists(dest)
                    if had_old:
                        copy_entry(dest, saved)
                    completed.append((dest, saved, had_old))
                    discard(dest)
                    if action['op'] == 'copy':
                        os.replace(staged, dest)
                    elif action['op'] == 'link':
                        dest.symlink_to(os.path.relpath(action['target'], dest.parent), target_is_directory=True)
                write_json(self.state_file, after)
            except Exception:
                for dest, saved, had_old in reversed(completed):
                    discard(dest)
                    if had_old:
                        copy_entry(saved, dest)
                write_json(self.state_file, before)
                raise
            finally:
                for work in staging:
                    shutil.rmtree(work)
            return dict(plan, applied=True, backup=str(backup))


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--home', help='Isolated home for testing; ignores tool directory environment overrides')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('inventory')
    for name in ['sync', 'import', 'link', 'remove']:
        cmd = sub.add_parser(name)
        cmd.add_argument('--apply', action='store_true', help='Write changes; otherwise only preview')
        if name in {'sync', 'import'}:
            cmd.add_argument('--source', required=True)
        if name == 'sync':
            cmd.add_argument('--adopt', action='store_true', help='Adopt identical unmanaged skills as common')
            cmd.add_argument('--prune', action='store_true', help='Remove obsolete managed common skills, with backups')
        if name == 'remove':
            cmd.add_argument('name')
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        manager = Manager(args.home)
        result = manager.inventory() if args.command == 'inventory' else manager.apply(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if result.get('conflicts') else 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())

"""Upstream skill sources: Git repositories and Agent Skills discovery indexes.

Each source entry in source.json is a plain JSON object; adding a provider that
uses one of these formats needs no code. Fetchers write `<name>/SKILL.md` skill
directories and return the upstream revision of every fetched skill.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import zipfile

import skills

DISCOVERY_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'
DISCOVERY_PATH = '/.well-known/agent-skills/index.json'
FIELDS = {'git': {'id', 'type', 'url', 'ref', 'path', 'skills'},
          'well-known': {'id', 'type', 'url', 'skills'}}
# Agent Skills names and source ids: lowercase letters, digits and inner hyphens, 1-64 chars.
SLUG = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
GIT_REF = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/+-]*')
MAX_INDEX = 4 << 20
MAX_ARTIFACT = 64 << 20
MAX_EXTRACTED = 256 << 20
MAX_FILES = 10000


def normalize(spec):
    """Validate one source entry and fill documented defaults."""
    if not isinstance(spec, dict):
        raise ValueError('来源必须是 JSON 对象')
    kind = spec.get('type')
    if kind not in FIELDS:
        raise ValueError('不支持的来源类型: ' + str(kind) + '（可用 git、well-known）')
    unknown = set(spec) - FIELDS[kind]
    if unknown:
        raise ValueError('来源包含未知字段: ' + ', '.join(sorted(unknown)))
    if not isinstance(spec.get('id'), str) or not SLUG.fullmatch(spec['id']):
        raise ValueError('来源 id 须为小写字母、数字和连字符，最长 64 个字符')
    url = spec.get('url')
    if not isinstance(url, str) or not url.strip():
        raise ValueError('来源缺少 url')
    url = url.strip()
    selection = spec.get('skills', '*')
    if selection != '*':
        if (not isinstance(selection, list) or not selection or len(set(selection)) != len(selection)
                or not all(isinstance(n, str) for n in selection)):
            raise ValueError('skills 须为 "*" 或不重复的技能名列表')
        for name in selection:
            skills.valid_name(name)
        selection = sorted(selection)
    result = {'id': spec['id'], 'type': kind, 'url': url}
    if kind == 'git':
        if not (url.startswith('https://') or os.path.isabs(url)):
            raise ValueError('Git 来源须使用 https:// 地址或控制中心本机绝对路径')
        ref = spec.get('ref', 'HEAD')
        if not isinstance(ref, str) or not GIT_REF.fullmatch(ref):
            raise ValueError('无效的 Git ref: ' + str(ref))
        path = spec.get('path', '')
        if not isinstance(path, str) or path.startswith('/') or '..' in PurePosixPath(path).parts:
            raise ValueError('path 须为仓库内的相对目录')
        result.update(ref=ref, path=path.strip('/'))
    else:
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.query or parts.fragment:
            raise ValueError('well-known 来源须为不带查询参数的 https:// 地址')
        if not parts.path.endswith(DISCOVERY_PATH):
            # Accept the publishing base URL and append the standard index path.
            url = url.rstrip('/') + DISCOVERY_PATH
        result['url'] = url
    result['skills'] = selection
    return result


def fetch(spec, into, pins=None, download=None):
    """Write the selected skills of one source into `into`; return {name: revision}.

    `pins` maps skill names to revisions from a reviewed preview; the fetch
    fails instead of returning anything newer.
    """
    spec = normalize(spec)
    if spec['type'] == 'git':
        return fetch_git(spec, Path(into), pins)
    return fetch_well_known(spec, Path(into), pins, download or http_get)


def select(spec, available):
    if spec['skills'] == '*':
        return sorted(available)
    missing = [n for n in spec['skills'] if n not in available]
    if missing:
        raise ValueError('来源 ' + spec['id'] + ' 中不存在技能: ' + ', '.join(missing))
    return spec['skills']


def fetch_git(spec, into, pins=None):
    pinned = set((pins or {}).values())
    if len(pinned) > 1:
        raise ValueError('同一 Git 来源的技能必须来自同一 commit')
    ref = pinned.pop() if pinned else spec['ref']
    if not GIT_REF.fullmatch(ref):
        raise ValueError('无效的 Git 版本')
    with tempfile.TemporaryDirectory(prefix='nodes-skills-git-') as tmp:
        checkout = Path(tmp) / 'repo'
        checkout.mkdir()

        def git(*args):
            result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *args],
                                    cwd=checkout, capture_output=True, text=True, timeout=120,
                                    env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
            if result.returncode:
                raise ValueError('读取来源仓库失败（' + spec['id'] + '）: ' + result.stderr[-1500:])
            return result.stdout.strip()
        git('init', '--quiet')
        git('remote', 'add', 'origin', spec['url'])
        git('fetch', '--quiet', '--depth=1', 'origin', ref)
        git('checkout', '--quiet', '--detach', 'FETCH_HEAD')
        commit = git('rev-parse', 'HEAD')
        if pins and commit != ref:
            raise ValueError('候选 commit 不一致')
        base = (checkout / spec['path']).resolve()
        if not (base == checkout.resolve() or checkout.resolve() in base.parents) or not base.is_dir():
            raise ValueError('来源 ' + spec['id'] + ' 的技能目录缺失或位于仓库之外')
        found = skills.discover(base)
        if spec['skills'] == '*':
            stray = [p.name for p in base.iterdir()
                     if p.is_dir() and not p.name.startswith('.') and p.name not in found]
            if stray:
                raise ValueError('来源 ' + spec['id'] + ' 的目录含非技能子目录（' + ', '.join(stray)
                                 + '），请设置 path 或列出 skills')
        names = select(spec, found)
        for name in names:
            skills.valid_name(name)
            shutil.copytree(found[name], into / name, symlinks=True)
            skills.tree(into / name)
        return {name: commit for name in names}


class HttpsOnlyRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != 'https':
            raise ValueError('拒绝非 HTTPS 重定向: ' + newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_get(url, limit):
    if urlsplit(url).scheme != 'https':
        raise ValueError('只允许 HTTPS 下载: ' + url)
    request = Request(url, headers={'User-Agent': 'nodes-skills-manage'})
    with build_opener(HttpsOnlyRedirect).open(request, timeout=60) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('下载内容超过大小上限: ' + url)
    return data


def fetch_well_known(spec, into, pins=None, download=http_get):
    """Agent Skills discovery v0.2.0: entries of type skill-md or archive, sha256 digests."""
    try:
        index = json.loads(download(spec['url'], MAX_INDEX))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError('来源 ' + spec['id'] + ' 的索引不是有效 JSON')
    if not isinstance(index, dict) or index.get('$schema') != DISCOVERY_SCHEMA:
        raise ValueError('来源 ' + spec['id'] + ' 的索引须声明 $schema ' + DISCOVERY_SCHEMA)
    entries = {}
    for entry in index.get('skills') if isinstance(index.get('skills'), list) else []:
        name = entry.get('name') if isinstance(entry, dict) else None
        if not isinstance(name, str) or not SLUG.fullmatch(name):
            raise ValueError('索引包含无效技能名: ' + str(name))
        if name in entries:
            raise ValueError('索引包含重复技能: ' + name)
        entries[name] = entry
    fetched = {}
    for name in select(spec, entries):
        entry = entries[name]
        kind, digest = entry.get('type'), entry.get('digest')
        if kind not in ('skill-md', 'archive') or not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError('索引条目 ' + name + ' 缺少有效的 type 或 sha256 digest')
        if pins is not None and pins.get(name) != digest:
            raise ValueError('上游 ' + name + ' 已在检查后变化，请重新检查更新')
        data = download(urljoin(spec['url'], str(entry.get('url', ''))), MAX_ARTIFACT)
        if 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('技能 ' + name + ' 的下载内容与索引 digest 不一致')
        target = into / name
        if kind == 'skill-md':
            target.mkdir()
            (target / 'SKILL.md').write_bytes(data)
        else:
            extract(data, target)
        declared = frontmatter_name(target / 'SKILL.md')
        if declared != name:
            raise ValueError('技能 ' + name + ' 的 SKILL.md name 与索引不一致: ' + str(declared))
        skills.tree(target)
        fetched[name] = digest
    return fetched


def frontmatter_name(path):
    match = re.match(r'---\r?\n(.*?)\r?\n---', path.read_text(encoding='utf-8'), re.S)
    name = re.search(r'^name:\s*(.+?)\s*$', match.group(1), re.M) if match else None
    return name.group(1).strip('\'"') if name else None


def members(data):
    """Yield (path, is_dir, mode, reader) from a tar(.gz/.bz2/.xz) or zip archive."""
    if data[:4] == b'PK\x03\x04':
        archive = zipfile.ZipFile(io.BytesIO(data))
        for info in archive.infolist():
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError('归档包含软链接: ' + info.filename)
            yield info.filename, info.is_dir(), mode, (lambda i=info: archive.read(i))
        return
    try:
        archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
    except tarfile.TarError:
        raise ValueError('不支持的归档格式（需要 tar.gz 或 zip）')
    with archive:
        for member in archive:
            if not (member.isdir() or member.isfile()):
                raise ValueError('归档包含不支持的条目: ' + member.name)
            yield member.name, member.isdir(), member.mode, (lambda m=member: archive.extractfile(m).read())


def extract(data, target):
    """Extract into `target`: SKILL.md at the archive root or inside one top-level directory."""
    with tempfile.TemporaryDirectory(prefix='nodes-skills-archive-', dir=target.parent) as tmp:
        staging = Path(tmp) / 'content'
        staging.mkdir()
        count = total = 0
        for name, is_dir, mode, read in members(data):
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name:
                raise ValueError('归档路径不安全: ' + name)
            if not path.parts or path.parts == ('.',):
                continue
            output = staging.joinpath(*path.parts)
            if is_dir:
                output.mkdir(parents=True, exist_ok=True)
                continue
            count += 1
            content = read()
            total += len(content)
            if count > MAX_FILES or total > MAX_EXTRACTED:
                raise ValueError('归档内容超过数量或大小上限')
            if output.exists():
                raise ValueError('归档包含重复路径: ' + name)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(content)
            output.chmod(0o755 if mode & 0o111 else 0o644)
        root = staging
        if not (root / 'SKILL.md').is_file():
            entries = [p for p in staging.iterdir() if p.name != '__MACOSX']
            if len(entries) != 1 or not (entries[0] / 'SKILL.md').is_file():
                raise ValueError('归档根目录或唯一顶层目录中缺少 SKILL.md')
            root = entries[0]
        root.rename(target)

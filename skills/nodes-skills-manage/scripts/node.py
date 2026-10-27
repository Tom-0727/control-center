#!/usr/bin/env python3
"""Run the manager through paseo-nodes-use, without installing it on nodes."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import threading
import zlib

sys.dont_write_bytecode = True
import skills


def pack_source(root):
    root = Path(root).expanduser().resolve(strict=True)
    found = skills.discover(root)
    if (root / 'SKILL.md').exists():
        raise ValueError('sync source must contain skill directories')
    unexpected = [p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith('.') and p.name not in found]
    if unexpected:
        raise ValueError('Non-flat or invalid skill directories: ' + ', '.join(unexpected))
    records = []
    for name, path in found.items():
        skills.valid_name(name)
        records.append([name, 'dir', '', 0])
        for rel, kind, data, executable in skills.tree(path):
            if kind == 'file':
                data = base64.b64encode((path / rel).read_bytes()).decode()
            records.append([name + '/' + rel, kind, data, executable])
    return records


# Only generated portable entries enter this private transport. The node's
# temporary directory is cleaned even when the manager reports a conflict.
BOOTSTRAP = '''
import base64,contextlib,io,json,os,sys,tempfile,zlib
from pathlib import Path
p=json.loads(zlib.decompress(PAYLOAD))
with tempfile.TemporaryDirectory(prefix='nodes-skills-run-') as tmp:
    argv=p['argv']
    if 'files' in p:
        source=Path(tmp)/'source'
        source.mkdir()
        for rel,kind,data,mode in p['files']:
            path=source/rel
            if kind=='dir':
                path.mkdir(parents=True,exist_ok=True)
            elif kind=='link':
                path.parent.mkdir(parents=True,exist_ok=True)
                path.symlink_to(data)
            else:
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(base64.b64decode(data))
                path.chmod(0o644|mode)
        argv[argv.index('--source')+1]=str(source)
    ns={'__name__':'nodes_skills_remote'}
    exec(compile(p['script'],'nodes-skills-manage/skills.py','exec'),ns)
    out=io.StringIO()
    with contextlib.redirect_stdout(out):
        code=ns['main'](argv)
    result=json.dumps({'exit_code':code,'result':json.loads(out.getvalue())},ensure_ascii=False).encode()
    encoded=base64.b64encode(result).decode()
    print('NSM_RESULT_BEGIN')
    for i in range(0,len(encoded),60):
        print(encoded[i:i+60])
    print('NSM_RESULT_END')
sys.exit(code)
'''


# Payloads whose base64 fits in one terminal command are sent inline; larger
# ones go through Paseo's native file upload (node.sh sdk-upload) in parts.
INLINE_LIMIT = 8000

# Removes only files created by sdk-upload: <paseo>/uploads/upload_<id>/nsm-*.
DISCARD = '''
import shutil
from pathlib import Path
def nsm_discard(paths):
    for item in paths:
        path=Path(item)
        if path.name.startswith('nsm-') and path.parent.name.startswith('upload_') and path.parent.parent.name=='uploads':
            shutil.rmtree(path.parent,ignore_errors=True)
'''

# Reads and verifies the uploaded parts, deleting them before the manager runs.
ASSEMBLE = DISCARD + '''
import hashlib,sys
try:
    chunks=[]
    for part in PARTS:
        data=Path(part['path']).read_bytes()
        if 'sha256:'+hashlib.sha256(data).hexdigest()!=part['sha256']:
            sys.exit('Uploaded payload part does not match its digest')
        chunks.append(data)
finally:
    nsm_discard([part['path'] for part in PARTS])
PAYLOAD=b''.join(chunks)
if 'sha256:'+hashlib.sha256(PAYLOAD).hexdigest()!=DIGEST:
    sys.exit('Uploaded payload does not match its digest')
'''


def inline_program(data):
    return 'import base64\nPAYLOAD=base64.b64decode(' + repr(base64.b64encode(data).decode()) + ')\n' + BOOTSTRAP


def uploaded_program(upload):
    parts = [{'path': p['path'], 'sha256': p['sha256']} for p in upload['parts']]
    return 'PARTS=' + repr(parts) + '\nDIGEST=' + repr(upload['sha256']) + '\n' + ASSEMBLE + BOOTSTRAP


def upload_payload(node_sh, node, data, timeout, report, uploaded):
    """Upload `data` with node.sh sdk-upload; record every remote path in `uploaded`."""
    with tempfile.NamedTemporaryFile(prefix='nsm-payload-') as payload, \
            tempfile.TemporaryFile(mode='w+') as errors:
        payload.write(data)
        payload.flush()
        final = None
        with subprocess.Popen([str(node_sh), node, 'sdk-upload', '--timeout', str(timeout), '--', payload.name],
                              stdout=subprocess.PIPE, stderr=errors, text=True) as process:
            # Each part has its own timeout and retries; this only bounds a stuck helper.
            guard = threading.Timer(timeout * 3 + 60 + len(data) / 10000, process.kill)
            guard.start()
            try:
                for line in process.stdout:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get('event') == 'progress':
                        report('transferring', {'bytes': event['bytes'], 'total_bytes': event['total_bytes']})
                    elif event.get('event') in ('result', 'error'):
                        final = event
                process.wait()
            finally:
                guard.cancel()
        errors.seek(0)
        stderr = errors.read()
    if final:
        uploaded.extend(final.get('uploaded') or [p['path'] for p in final.get('parts', [])])
    if not final or final['event'] != 'result' or process.returncode:
        raise RuntimeError('Payload upload failed: ' + ((final or {}).get('error') or stderr[-1500:] or 'no result'))
    if final['sha256'] != 'sha256:' + hashlib.sha256(data).hexdigest() or sum(p['size'] for p in final['parts']) != len(data):
        raise RuntimeError('Upload helper reported a different payload')
    return final


def run_remote(node, workspace, argv, paseo_dir, timeout=120, progress=None):
    args = skills.parser().parse_args(argv)
    payload = {'script': Path(__file__).with_name('skills.py').read_text(encoding='utf-8'), 'argv': argv}
    if args.command == 'sync':
        # Require the unambiguous token form because its value is replaced remotely.
        if '--source' not in argv:
            raise ValueError('Use --source PATH, not --source=PATH')
        payload['files'] = pack_source(args.source)
    data = zlib.compress(json.dumps(payload).encode(), 9)
    scripts = Path(paseo_dir).resolve() / 'scripts'
    exec_sh, node_sh = scripts / 'exec.sh', scripts / 'node.sh'
    for path in (exec_sh, node_sh):
        if not path.is_file():
            raise ValueError('Missing paseo-nodes-use script: ' + str(path))

    def execute(code):
        command = 'python3 -c ' + shlex.quote(code)
        return subprocess.run([str(exec_sh), node, '--workspace', workspace, '--timeout', str(timeout), '--', command],
                              text=True, capture_output=True, timeout=timeout + 60)

    def report(phase, fields):
        if progress:
            progress(phase, fields)
        elif phase == 'transferring':
            sys.stderr.write('Uploading skill payload: ' + str(fields['bytes']) + '/' + str(fields['total_bytes']) + '\n')

    # One temporary terminal runs the manager; nothing is installed on the node.
    uploaded = []
    finished = False
    try:
        if len(data) * 4 // 3 <= INLINE_LIMIT:
            run = execute(inline_program(data))
        else:
            upload = upload_payload(node_sh, node, data, timeout, report, uploaded)
            if progress:
                progress('applying' if args.command != 'inventory' and args.apply else 'checking', {})
            run = execute(uploaded_program(upload))
        sys.stderr.write(run.stderr)
        lines = run.stdout.splitlines()
        try:
            start, end = lines.index('NSM_RESULT_BEGIN'), lines.index('NSM_RESULT_END')
            result = json.loads(base64.b64decode(''.join(lines[start+1:end]), validate=True))
        except (ValueError, IndexError) as e:
            raise RuntimeError('Paseo did not return a complete result: ' + (run.stderr or run.stdout)[-3000:]) from e
        if run.returncode != result['exit_code']:
            raise RuntimeError('Paseo exit code disagrees with result')
        finished = True
        return result
    finally:
        if uploaded and not finished:
            # The assembling program deletes parts itself; this covers runs that never reached it.
            try:
                cleanup = execute(DISCARD + 'nsm_discard(' + repr(uploaded) + ')')
                if cleanup.returncode:
                    raise RuntimeError('cleanup failed')
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                sys.stderr.write('Uploaded payload cleanup failed on node: ' + ', '.join(uploaded) + '\n')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('node')
    p.add_argument('--workspace', required=True)
    default = Path(__file__).resolve().parents[2] / 'paseo-nodes-use'
    p.add_argument('--paseo-dir', default=str(default))
    p.add_argument('--timeout', type=int, default=120)
    # Everything after -- belongs to skills.py, including its test --home.
    raw = sys.argv[1:]
    if '--' not in raw:
        p.error('Separate manager arguments with --')
    split = raw.index('--')
    args = p.parse_args(raw[:split])
    try:
        result = run_remote(args.node, args.workspace, raw[split+1:], args.paseo_dir, args.timeout)
        print(json.dumps({'node': args.node, **result}, ensure_ascii=False, indent=2))
        return result['exit_code']
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as e:
        print(json.dumps({'node': args.node, 'error': str(e)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())

"""Synthetic private process fixture; canonical authority/journal are not mocked."""
import asyncio
from contextlib import contextmanager
from dataclasses import replace
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys

source = Path(os.environ['CANONICAL_PROJECT_SOURCE']).resolve(strict=True)
sys.path.insert(0, str(source/'bin'))
import project_authority as a
import project_binding as b
import project_carrier as c
import project_invocation_host as h

spec = importlib.util.spec_from_file_location('connection', sys.argv[1])
connection = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = connection
spec.loader.exec_module(connection)
root = Path(sys.argv[2]).resolve(strict=True)
payload = b'approved fixture input'
raw = dict(version=1,project='gym-nyc',request_id='r1',execution_id='x1',
    source_revision='a'*40,workspace=str(root),instruction_digest='b'*64,policy_digest='c'*64,
    executor='codex',host='fixture',profile='default',claim_id='claim1',epoch=2,
    authorization_id='human1',credential_id='credential1',operation='edit',
    paths=['src/component.py'],checks=['unit'],review_remaining=1,retry_remaining=0,
    evidence_destination='evidence/r1',payload_digest=hashlib.sha256(payload).hexdigest())
state = b.Authority(b.fingerprint(raw),100,90,110,False,False,True,True,2,
    'ENFORCED','a'*40,'b'*64,'c'*64,str(root),('src','evidence'),('unit',),('edit',),
    'codex','fixture','default',1,0)

def control():
    p=root/'control.json'
    return json.loads(p.read_text()) if p.exists() else {}

class Adapter:
    @contextmanager
    def transaction(self, raw, stage):
        controls=control()
        current=replace(state,credential_revoked=controls.get('revoked',False),
                        human_origin_verified=not controls.get('noHuman',False))
        if stage=='resume' and controls.get('denyResume'):
            current=replace(current,credential_revoked=True)
        if stage=='effect' and controls.get('denyEffect'):
            current=replace(current,credential_revoked=True)
        (root/'fence.json').write_text(json.dumps({'inside':True,'stage':stage}))
        try:
            yield current
            if stage=='effect' and control().get('exitFail'):
                raise RuntimeError('synthetic lost fence acknowledgment')
        finally:
            (root/'fence.json').write_text(json.dumps({'inside':False,'stage':stage}))

@contextmanager
def factory(mapping):
    ledger=sqlite3.connect(root/'journal.sqlite')
    registry=sqlite3.connect(root/'permissions.sqlite')
    try:
        h.install_schema(ledger);a.install_schema(registry)
        yield h.InvocationHost(ledger,a.PermissionStore(registry,Adapter(),clock=lambda:100),
                               mapping,clock=lambda:100)
    finally:
        registry.close();ledger.close()

async def main():
    target=h.Target('bridge','m1','codex-1','q1')
    association=c.Association(*(raw[k] for k in ('project','request_id','execution_id','payload_digest')))
    channel=connection.CanonicalInvocationChannel(factory,
        {'codex-1':connection.Identity('codex','fixture','default')},
        [connection.Route(target,association,raw,payload)])
    async def read(limit):
        return await asyncio.to_thread(sys.stdin.buffer.readline,limit)
    async def write(data):
        sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
    try:
        await channel.serve(read,write)
    except Exception:
        # Protocol errors have fixed diagnostics; never print private bindings.
        print('synthetic channel rejected',file=sys.stderr)
        raise SystemExit(2)

asyncio.run(main())

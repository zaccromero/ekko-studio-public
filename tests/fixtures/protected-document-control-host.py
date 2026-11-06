"""Isolated Node/Python pipe fixture. Human/owner/authority/model SYNTHETIC.

Reads reviewed source modules; opens only fresh fixture Git/SQLite/files/pipes.
No live ownership board, credential, provider, model, network or Ekko service.
"""
import asyncio
import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys

ROOT = Path(os.environ['CANONICAL_PROJECT_SOURCE']).resolve(strict=True)
spec = importlib.util.spec_from_file_location('document_pipe_fixture', ROOT/'tests/project-document-channel-contract.py')
fixture = importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)


async def main():
    case = fixture.DocumentChannelTests()
    try:
        await case.asyncSetUp()
        await case.stop()  # Close the test's in-memory port; use real stdio below.
        driver = case.new_driver()
        endpoint = fixture.channel.DocumentControlChannel(driver, target=case.target,
            association=case.association, binding_digest=case.digest, saved_digest=case.hint)
        reader = asyncio.StreamReader()
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        class Writer:
            def write(self, value):os.write(sys.stdout.fileno(), value)
            async def drain(self):await asyncio.sleep(0)
        frame = case.frame()
        descriptor = dict(target=frame['target'], binding=dict(carrier=frame['carrier'],
            association=frame['association']), expected_digest=case.value,
            destination=str(case.f.destination), fixture_authority='SYNTHETIC')
        with os.fdopen(3, 'wb') as stream:
            stream.write(json.dumps(descriptor).encode());stream.flush()
        try:
            await endpoint.serve(reader, Writer())
            assert driver._context is None and driver._close_future.done()
            assert case.calls == [b'approved input']
        finally:transport.close()
    finally:
        # Equivalent to unittest's registered cleanup, on this SAME event loop.
        while case._cleanups:
            function, args, kwargs = case._cleanups.pop()
            value = function(*args, **kwargs)
            if inspect.isawaitable(value):await value


if __name__ == '__main__':asyncio.run(main())

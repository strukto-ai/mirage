# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import hashlib
import json
import logging
import os
import shlex
import tempfile
import time
import uuid
from pathlib import Path

import asyncssh
from dotenv import find_dotenv, load_dotenv
from e2b import AsyncSandbox
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError

from mirage import Limit, MountMode, Workspace
from mirage.runtime.sandbox.e2b import E2BRuntime
from mirage.runtime.sandbox.ssh import SSHRuntime
from mirage.vfs.ram import RAMVFS
from mirage.vfs.ssh import SSHVFS, SSHConfig

ROOT = Path(__file__).resolve().parents[2]


def passed(name, **details):
    print(json.dumps({'check': name, **details}), flush=True)


async def relay(reader, writer, url):
    try:
        async with connect(url, max_size=None) as ws:

            async def to_ws():
                while data := await reader.read(65536):
                    await ws.send(data)
                await ws.close()

            async def from_ws():
                async for data in ws:
                    writer.write(data)
                    await writer.drain()

            tasks = [
                asyncio.create_task(to_ws()),
                asyncio.create_task(from_ws())
            ]
            try:
                done, _ = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    try:
                        task.result()
                    except ConnectionClosedError:
                        if not reader.at_eof():
                            raise
                        # websocat --exit-on-eof may omit the WS close reply
                        # after the local SSH client has already disconnected.
                        logging.getLogger(__name__).debug(
                            "SSH client closed before WebSocket close reply")
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        writer.close()
        await writer.wait_closed()


async def exercise(runtime, label):
    code = ('import sys,hashlib; '
            'print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
    line = f'python3 -c {shlex.quote(code)}'
    for data in (None, b'', bytes(range(256)) * 1024):
        result = await asyncio.wait_for(
            runtime.run_line(line, data, {}, '/home/user'), 30)
        assert result.exit_code == 0, result
        assert result.stdout.decode().strip() == hashlib.sha256(
            data or b'').hexdigest(), result
    for _ in range(6):
        result = await runtime.run_line('printf out; printf err >&2; exit 7',
                                        b'input', {}, '/home/user')
        assert (result.stdout, result.stderr,
                result.exit_code) == (b'out', b'err', 7), result
    code = ('import sys,time,json; s=time.time(); '
            'd=sys.stdin.buffer.read(); time.sleep(2); '
            'print(json.dumps([s,time.time(),d.hex()]))')
    line = f'python3 -c {shlex.quote(code)}'
    start = time.monotonic()
    results = await asyncio.gather(
        *(runtime.run_line(line, bytes([i]), {}, '/home/user')
          for i in range(6)))
    parsed = [json.loads(r.stdout) for r in results]
    assert [p[2] for p in parsed] == [bytes([i]).hex() for i in range(6)]
    assert max(p[0] for p in parsed) < min(p[1] for p in parsed), parsed
    passed(label + '_stdin_eof_exit_parallel',
           seconds=round(time.monotonic() - start, 2))


async def wait_for_remote(runtime, command):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = await runtime.run_line(command, None, {}, '/home/user')
        if result.exit_code == 0:
            return
        await asyncio.sleep(0.1)
    raise AssertionError(
        'Remote cancellation check did not reach the expected process state')


async def exercise_cancellation(runtime):
    workspace = Workspace(
        {
            '/home/user': (RAMVFS(), MountMode.EXEC, {
                'exec': Limit(timeout_seconds=5)
            })
        },
        mode=MountMode.EXEC,
        runtimes=[runtime, 'workspace'])
    try:
        for mode in ('caller', 'timeout'):
            path = f'/home/user/mirage-cancel-{uuid.uuid4().hex}.pid'
            code = ('import os,time; from pathlib import Path; '
                    f'Path("{path}").write_text(str(os.getpid())); '
                    'time.sleep(60)')
            task = asyncio.create_task(
                workspace.shell(f'exec python3 -c {shlex.quote(code)}',
                                cwd='/home/user'))
            try:
                await wait_for_remote(runtime, f'test -s {path}')
                survivor = asyncio.create_task(
                    runtime.run_line('sleep 1; printf survivor', None, {},
                                     '/home/user'))
                if mode == 'caller':
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        assert task.cancelled()
                    else:
                        raise AssertionError(
                            'Cancelled command returned successfully')
                else:
                    assert (await task).exit_code == 124
                await wait_for_remote(runtime,
                                      f'! kill -0 $(cat {path}) 2>/dev/null')
                assert (await survivor).stdout == b'survivor'
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                await runtime.run_line(
                    f'if test -s {path}; then kill -9 $(cat {path}) '
                    f'2>/dev/null || true; fi; rm -f {path}', None, {},
                    '/home/user')
        passed('python_e2b_caller_and_timeout_kill_pid')
    finally:
        await workspace.close()


async def main():
    load_dotenv(find_dotenv('.env.development', usecwd=True))
    key = os.environ['E2B_API_KEY']
    sandbox = None
    bridge = None
    runtime = None
    workspace = None
    try:
        sandbox = await AsyncSandbox.create(api_key=key, timeout=1200)
        passed('sandbox_created', sandbox_id=sandbox.sandbox_id)
        e2b = E2BRuntime(config={
            'sandbox_id': sandbox.sandbox_id,
            'api_key': key
        })
        await exercise(e2b, 'python_e2b')
        await exercise_cancellation(e2b)
        passed('bootstrap_started')
        install = await sandbox.commands.run(
            'sudo apt-get update -qq && '
            'sudo env DEBIAN_FRONTEND=noninteractive '
            'apt-get install -y -qq openssh-server && '
            'curl -fsSL https://github.com/vi/websocat/releases/'
            'download/v1.14.0/websocat.x86_64-unknown-linux-musl '
            '-o /tmp/websocat && chmod 755 /tmp/websocat && '
            'mkdir -p /home/user/.ssh /home/user/work && '
            'chmod 700 /home/user/.ssh && sudo mkdir -p /run/sshd',
            timeout=180)
        passed('ssh_installed', exit_code=install.exit_code)
        with tempfile.TemporaryDirectory(
                prefix='mirage-e2b-ssh-') as directory:
            identity = Path(directory) / 'id_ed25519'
            ssh_key = asyncssh.generate_private_key('ssh-ed25519')
            identity.write_bytes(ssh_key.export_private_key())
            identity.chmod(0o600)
            await sandbox.files.write('/home/user/.ssh/authorized_keys',
                                      ssh_key.export_public_key().decode())
            await sandbox.commands.run(
                'chmod 600 /home/user/.ssh/authorized_keys', timeout=20)
            await sandbox.commands.run(
                'sudo /usr/sbin/sshd -D -e -p 2222 '
                '-o ListenAddress=127.0.0.1 -o PasswordAuthentication=no '
                '-o PermitRootLogin=no',
                background=True,
                timeout=1000)
            await sandbox.commands.run(
                '/tmp/websocat -b --exit-on-eof '
                'ws-l:0.0.0.0:8081 tcp:127.0.0.1:2222',
                background=True,
                timeout=1000)
            url = f'wss://{sandbox.get_host(8081)}'

            async def accept(reader, writer):
                await relay(reader, writer, url)

            bridge = await asyncio.start_server(accept, '127.0.0.1', 0)
            port = bridge.sockets[0].getsockname()[1]
            cfg = dict(host='127.0.0.1',
                       port=port,
                       username='user',
                       identity_file=str(identity))
            runtime = SSHRuntime(captures=['python3'], config=cfg)
            await exercise(runtime, 'python_ssh')
            conn = runtime._conn
            await runtime.run_line('true', None, {}, '/home/user')
            assert runtime._conn is conn
            passed('python_ssh_connection_reused')
            vfs = SSHVFS(SSHConfig(root='/home/user/work', **cfg))
            workspace = Workspace({'/home/user/work': vfs},
                                  mode=MountMode.EXEC,
                                  runtimes=[runtime, 'workspace'])
            result = await workspace.shell('cat > /home/user/work/output.txt',
                                           stdin=b'old')
            assert result.exit_code == 0
            result = await workspace.shell('cat /home/user/work/output.txt')
            assert await result.stdout_str() == 'old'
            result = await workspace.shell('cat > /home/user/work/input.txt',
                                           stdin=b'from vfs')
            assert result.exit_code == 0, await result.stderr_str()
            code = ('from pathlib import Path; p=Path("/home/user/work"); '
                    'assert (p/"input.txt").read_text()=="from vfs"; '
                    '(p/"output.txt").write_text("from ssh")')
            result = await workspace.shell(f'python3 -c {shlex.quote(code)}',
                                           cwd='/home/user/work')
            assert result.exit_code == 0, await result.stderr_str()
            result = await workspace.shell('cat /home/user/work/output.txt')
            assert await result.stdout_str() == 'from ssh'
            passed('python_router_shared_sftp_files')
            await sandbox.commands.run('python3 -m pip install -q mcp==1.26.0',
                                       timeout=120)
            await sandbox.files.write(
                '/tmp/mcp_stdio.py',
                (ROOT / 'integ/fixtures/runtime/mcp_stdio.py').read_text())
            async with conn.create_process('python3 -u /tmp/mcp_stdio.py',
                                           encoding=None) as process:

                async def request(message):
                    process.stdin.write(json.dumps(message).encode() + b'\n')
                    await process.stdin.drain()
                    response = json.loads(await asyncio.wait_for(
                        process.stdout.readline(), 30))
                    assert response['id'] == message[
                        'id'] and 'error' not in response, response
                    return response['result']

                init = await request({
                    'jsonrpc': '2.0',
                    'id': 1,
                    'method': 'initialize',
                    'params': {
                        'protocolVersion': '2024-11-05',
                        'capabilities': {},
                        'clientInfo': {
                            'name': 'mirage-test',
                            'version': '1'
                        }
                    }
                })
                assert init['serverInfo'][
                    'name'] == 'Mirage SSH transport probe'
                process.stdin.write(
                    b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
                )
                listed = await request({
                    'jsonrpc': '2.0',
                    'id': 2,
                    'method': 'tools/list',
                    'params': {}
                })
                assert [t['name'] for t in listed['tools']] == ['echo']
                for ident, value in [(3, 'first'), (4, 'second')]:
                    result = await request({
                        'jsonrpc': '2.0',
                        'id': ident,
                        'method': 'tools/call',
                        'params': {
                            'name': 'echo',
                            'arguments': {
                                'value': value
                            }
                        }
                    })
                    assert result['content'][0]['text'] == value, result
                process.stdin.write_eof()
                await asyncio.wait_for(process.wait(), 15)
            assert runtime._conn is conn
            passed('mcp_stdio_multiple_requests_on_reused_ssh_connection')

            # Keep the bridge available while the TypeScript twin exercises it.
            ts_script = ROOT / 'integ/runtime/e2b.ts'
            child_env = {
                **os.environ, 'E2B_API_KEY': key,
                'E2B_SANDBOX_ID': sandbox.sandbox_id,
                'E2B_SSH_PORT': str(port),
                'E2B_SSH_IDENTITY': str(identity)
            }
            process = await asyncio.create_subprocess_exec(str(
                ROOT / 'examples/typescript/node_modules/.bin/tsx'),
                                                           str(ts_script),
                                                           cwd=ROOT,
                                                           env=child_env)
            assert await process.wait() == 0
            passed('typescript_transport_checks')
            await workspace.close()
            workspace = None
            await runtime.close()
            runtime = None
            bridge.close()
            await bridge.wait_closed()
            bridge = None
        await e2b.close()
        assert await sandbox.is_running()
        passed('closing_runtime_preserves_sandbox')
    except Exception as exc:
        passed('FAILED',
               error=str(exc).replace(key, '[REDACTED]'),
               type=type(exc).__name__)
        raise SystemExit(1) from None
    finally:
        try:
            if workspace is not None:
                await workspace.close()
            if runtime is not None:
                await runtime.close()
            if bridge is not None:
                bridge.close()
                await bridge.wait_closed()
        finally:
            if sandbox is not None:
                await sandbox.kill()
                passed('sandbox_destroyed', sandbox_id=sandbox.sandbox_id)


if __name__ == "__main__":
    asyncio.run(main())

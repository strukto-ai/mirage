import asyncio

import pytest

from mirage import Workspace
from mirage.process.types import SpawnRequest
from mirage.runtime.python.monty.runtime import MontyRuntime
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS


@pytest.mark.asyncio
async def test_spawn_preserves_literal_argv_and_uses_admission():
    ws = Workspace({'/data': RAMVFS()}, runtimes=[])
    try:
        argv = ('printf', '%s|', 'a b', '$(echo bad)', '*', "a'b", '', '`')
        result = await ws.spawn(SpawnRequest(argv)).communicate()
        assert result.stdout == b"a b|$(echo bad)|*|a'b||`|"
        ws.create_session('limited',
                          profile={'commands': {
                              'deny': ['printf']
                          }})
        refused = await ws.spawn(SpawnRequest(argv), 'limited').communicate()
        assert refused.exit_code != 0
        assert refused.stdout == b''
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_spawn_drains_pipes_and_isolates_session_state():
    ws = Workspace({}, runtimes=[])
    try:
        data = b'x' * 300000
        result = await asyncio.wait_for(
            ws.spawn(SpawnRequest(('cat', ))).communicate(data), 3)
        assert result.stdout == data
        result = await ws.spawn(
            SpawnRequest(('pwd', ),
                         cwd=PathSpec.from_str_path('/tmp'))).communicate()
        assert result.stdout == b'/tmp\n'
        assert (await ws.shell('pwd')).stdout == b'/\n'
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_profile_process_views_and_revocation():
    ws = Workspace({}, runtimes=[])
    try:
        a = ws.create_session('a')
        ws.create_session('b')
        child = ws.spawn(SpawnRequest(('sleep', '30')), 'a')
        child.stdin.close()
        view = ws._process_view(a)
        assert view.get(child.pid) is not None
        assert ws.processes.view('b').get(child.pid) is None
        await ws.set_session_profile(
            'a', {'processes': {
                'spawn': False,
                'metadata': 'none'
            }})
        assert view.list() == ()
        assert view.spawn is not None
        with pytest.raises(PermissionError):
            view.spawn(SpawnRequest(('true', )))
        await asyncio.wait_for(child.wait(), 2)
        with pytest.raises(PermissionError):
            ws.spawn(SpawnRequest(('true', )), 'a')
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_monty_keeps_unsupported_subprocess_import():
    ws = Workspace({}, runtimes=[MontyRuntime()], mode=MountMode.EXEC)
    try:
        result = await asyncio.wait_for(
            ws.spawn(SpawnRequest(
                ('python', '-c', 'import subprocess'))).communicate(), 20)
        assert result.exit_code == 1
        assert b"ModuleNotFoundError" in result.stderr
        result = await ws.spawn(
            SpawnRequest(('python', '-c', 'mirage_run([])'))).communicate()
        assert result.exit_code == 1
        assert b"NameError" in result.stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_spawn_uses_programs_and_exported_environment():
    ws = Workspace({}, runtimes=[])
    try:
        await ws.shell('LOCAL=private; export PARENT=outer; '
                       'f() { echo wrong; }; printf() { echo wrong; }')
        for name in ('f', 'cd', 'missing'):
            with pytest.raises(FileNotFoundError):
                ws.spawn(SpawnRequest((name, )))
        result = await ws.spawn(SpawnRequest(
            ('printf', '-v', 'name', 'value'))).communicate()
        assert result.stdout == b'-v'
        result = await ws.spawn(SpawnRequest(
            ('printenv', 'LOCAL'))).communicate()
        assert result.exit_code == 1
        result = await ws.spawn(
            SpawnRequest(('printenv', 'PARENT'), env={},
                         replace_env=True)).communicate()
        assert result.exit_code == 1
        result = await ws.spawn(
            SpawnRequest(('printenv', 'PARENT'), env={'PARENT':
                                                      'child'})).communicate()
        assert result.stdout == b'child\n'
        assert (await ws.shell('printf %s "$PARENT"')).stdout == b'outer'
        result = await ws.spawn(
            SpawnRequest(('sh', '-c', 'printf out; printf err >&2'),
                         merge_stderr=True)).communicate()
        assert result.stdout == b'outerr'
        assert result.stderr == b''
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_spawn_output_obeys_the_command_limit_wherever_the_parent_writes(
):
    ws = Workspace({}, runtimes=[])
    try:
        session = ws.create_session(
            'capped', profile={'command_limits': {
                'cat': {
                    'max_bytes': 4
                }
            }})
        piped = session.fork()
        piped.terminal_output = False
        result = await ws._spawn_for_session(SpawnRequest(('cat', )),
                                             piped).communicate(b'0123456789')
        assert result.stdout == b'0123'
    finally:
        await ws.close()

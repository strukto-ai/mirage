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
async def test_monty_guest_nested_process_uses_same_admission():
    ws = Workspace({}, runtimes=[MontyRuntime()], mode=MountMode.EXEC)
    try:
        code = ('r = await mirage_run(["printf", "%s", "$(literal)"]); '
                'print(r["stdout"])')
        result = await asyncio.wait_for(
            ws.spawn(SpawnRequest(('python', '-c', code))).communicate(), 20)
        assert result.exit_code == 0, result.stderr
        assert result.stdout == b'$(literal)\n'
        nested = ('print((await mirage_run(["python", "-c", "print(42)"]))'
                  '["stdout"])')
        result = await asyncio.wait_for(
            ws.spawn(SpawnRequest(('python', '-c', nested))).communicate(), 20)
        assert result.exit_code == 0, result.stderr
        assert result.stdout == b'42\n\n'
    finally:
        await ws.close()

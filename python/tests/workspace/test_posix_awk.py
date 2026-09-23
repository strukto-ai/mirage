import json
from pathlib import Path

import pytest

from mirage import Workspace
from mirage.vfs.ram import RAMVFS

ROOT = Path(__file__).resolve().parents[3]
CASES = [
    case for name in ('bash/test/posix.json', 'unix/awk/redirect.json')
    for case in json.loads((ROOT / 'integ' / name).read_text())['cases']
]


@pytest.mark.asyncio
@pytest.mark.parametrize('case', CASES, ids=[case['id'] for case in CASES])
async def test_shared_shell_cases(case):
    ws = Workspace({'/data': RAMVFS()}, mode='exec')
    try:
        result = await ws.shell(case['command'])
        expected = case['expect']
        assert (result.exit_code, result.stdout.decode(),
                (result.stderr
                 or b'').decode()) == (expected['exit'], expected['stdout'],
                                       expected['stderr'])
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_awk_dispatches_across_mounts_and_stops_on_write_failure():
    ws = Workspace({'/data': RAMVFS(), '/other': RAMVFS()}, mode='exec')
    try:
        result = await ws.shell(
            'echo hi > /data/in; awk \'{print > "/other/out"}\' /data/in; '
            'cat /other/out')
        assert result.stdout == b'hi\n'
        result = await ws.shell(
            'awk \'BEGIN {print "before"; print "x" > "/data/missing/out"; '
            'print "after" > "/other/after"} END {print "end"}\'')
        assert result.exit_code == 2
        assert result.stdout == b'before\n'
        assert b'No such file or directory' in result.stderr
        assert (await ws.shell('test -e /other/after')).exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_awk_file_output_respects_read_only_mount():
    ws = Workspace({'/data': RAMVFS()}, mode='read')
    try:
        result = await ws.shell('awk \'BEGIN {print "x" > "/data/out"}\'')
        assert result.exit_code == 2
        assert (await ws.shell('test -e /data/out')).exit_code == 1
    finally:
        await ws.close()

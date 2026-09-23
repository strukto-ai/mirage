from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.spec.types import Operand
from mirage.io.types import IOResult, materialize
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest_asyncio.fixture
async def ws() -> AsyncIterator[Workspace]:
    workspace = Workspace(
        {
            '/data': RAMVFS(),
            '/tmp': RAMVFS(),
            '/work': RAMVFS()
        },
        mode=MountMode.WRITE)
    try:
        yield workspace
    finally:
        await workspace.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('line,stdout,stderr', [
    ('echo a - 2>&1', b'a -\n', b''),
    ('echo é - 2>/dev/null', 'é -\n'.encode(), b''),
    ('echo a - 1>&2', b'', b'a -\n'),
    ('echo a - 2>>/data/err', b'a -\n', b''),
    ('f() { echo "argc=$#"; }; f a - 2>&1', b'argc=2\n', b''),
    ('echo a - - 2>&1', b'a - -\n', b''),
    ('echo a "-" 2>&1', b'a -\n', b''),
    ('echo a - >/data/out; cat /data/out', b'a -\n', b''),
])
async def test_dash_before_redirect(ws: Workspace, line: str, stdout: bytes,
                                    stderr: bytes) -> None:
    result = await ws.shell(line)
    assert (result.exit_code, result.stdout, (result.stderr
                                              or b"")) == (0, stdout, stderr)


@pytest.mark.asyncio
@pytest.mark.parametrize('archive',
                         ['tar -cf /data/o.tar', 'zip -qr /data/o.zip'])
async def test_archive_after_dynamic_cd(ws: Workspace, archive: str) -> None:
    await ws.shell('mkdir -p /data/nd; echo hi > /data/nd/a')
    result = await ws.shell(f'd=/data/nd; cd "$d" && {archive} .; echo rc=$?')
    assert (result.exit_code, result.stdout, (result.stderr
                                              or b"")) == (0, b'rc=0\n', b'')
    result = await ws.shell(
        f'echo before > /data/marker; {archive} /data; echo after')
    assert result.stdout == b'after\n'
    assert b'Device or resource busy' in result.stderr
    assert (await ws.shell('cat /data/marker')).stdout == b'before\n'


@pytest.mark.asyncio
@pytest.mark.parametrize('cwd,target,directory', [
    ('/work', '/tmp', True),
    ('/work', '/tmp', False),
    ('/tmp', '/work', True),
    ('/', '/tmp', False),
])
async def test_mktemp_target_mount(ws: Workspace, cwd: str, target: str,
                                   directory: bool) -> None:
    result = await ws.shell(
        f'cd {cwd}; mktemp {"-d " if directory else ""}{target}/t.XXXXXX')
    assert result.exit_code == 0, result.stderr
    path = result.stdout.decode().strip()
    assert path.startswith(target + '/t.')
    assert (
        await
        ws.shell(f'test -{"d" if directory else "f"} {path}')).exit_code == 0
    if cwd != "/":
        assert (await ws.shell(f'test -e {cwd}{path}')).exit_code != 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [('cat -', 'a\nb\n'), ('wc -l -', '2 -\n'), ('sort -', 'a\nb\n'),
     ('grep a -', 'a\n'), ('cut -c1 -', 'a\nb\n'), ('head -n1 -', 'a\n'),
     ('tail -n1 -', 'b\n'), ("sed 's/a/A/' -", 'A\nb\n'), ('uniq -', 'a\nb\n'),
     ("awk '{print $1}' -", 'a\nb\n'), ('paste -sd, -', 'a,b\n'),
     ('cat - -', 'a\nb\n'), ('tr a A < /dev/stdin', 'A\nb\n'),
     ('cat /data/file - /data/file', 'file\na\nb\nfile\n'),
     ('cat - 2>&1', 'a\nb\n'), ('cat /dev/stdin', 'a\nb\n'),
     ('paste - -', 'a\tb\n')])
async def test_stdin_operands(ws: Workspace, command: str,
                              expected: str) -> None:
    await ws.shell('echo file > /data/file')
    result = await ws.shell("printf 'a\nb\n' | " + command)
    assert (result.exit_code, result.stdout.decode(), result.stderr
            or b'') == (0, expected, b'')


@pytest.mark.asyncio
async def test_dash_cli_stdin(ws: Workspace) -> None:
    seen: list[str] = []

    async def consume(inv: CLIInvocation[None]) -> tuple[bytes, IOResult]:
        seen.extend(inv.texts)
        return await materialize(inv.stdin), IOResult()

    ws.register_cli(
        'consume', CLISpec(name='consume',
                           rest=Operand(type='str'),
                           fn=consume))
    result = await ws.shell('printf body | consume - 2>&1')
    assert result.exit_code == 0
    assert result.stdout == b'body'
    assert seen == ['-']

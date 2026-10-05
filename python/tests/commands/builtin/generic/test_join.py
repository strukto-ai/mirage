import pytest

from mirage.commands.builtin.generic.join import (
    CheckOrder,
    JoinFlags,
    join,
    parse_flags,
)
from mirage.commands.errors import UsageError
from mirage.core.ram.write import write
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

GNU = [
    (
        "v1v2",
        b"1 a\n2 b\n3 c\n",
        b"1 x\n3 z\n4 w\n",
        "join -v1 -v2 a b",
        b"",
        0,
        b"2 b\n4 w\n",
        b"",
    ),
    (
        "unsorted_task",
        b"b one\na two\n",
        b"a x\nb y\n",
        "join a b",
        b"",
        1,
        b"b one y\n",
        b"join: a:2: is not sorted: a two\njoin: input is not in sorted order\n",
    ),
]


async def _drain(source) -> bytes:
    if source is None:
        return b""
    if isinstance(source, bytes):
        return source
    return b"".join([chunk async for chunk in source])


async def _shell(
    files: dict[str, bytes], cmd: str, stdin: bytes
) -> tuple[int, bytes, bytes]:
    ram = RAMVFS()
    for name, body in files.items():
        await write(ram.accessor, PathSpec.from_str_path(name), body)
    ws = Workspace({"/data": (ram, MountMode.WRITE)}, mode=MountMode.WRITE)
    ws._cwd = "/data"
    io = await ws.shell(cmd, stdin=stdin or None)
    return io.exit_code, await _drain(io.stdout), await _drain(io.stderr)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case,a,b,cmd,stdin,code,stdout,stderr", GNU, ids=[row[0] for row in GNU]
)
async def test_matches_gnu(case, a, b, cmd, stdin, code, stdout, stderr):
    """Each row is GNU join 9.7 (debian:stable-slim) run on files a and b."""
    assert await _shell({"/a": a, "/b": b}, cmd, stdin) == (
        code,
        stdout,
        stderr,
    )


@pytest.mark.parametrize(
    "flags,expected",
    [
        ({}, JoinFlags()),
        (
            {"a": "2", "v": "1"},
            JoinFlags(unpairables1=True, unpairables2=True, pairables=False),
        ),
        ({"j": "3"}, JoinFlags(field1=2, field2=2)),
        ({"t": ""}, JoinFlags(tab=b"\n", output_separator=b" ")),
        ({"t": "\\0"}, JoinFlags(tab=b"\0", output_separator=b"\0")),
        ({"o": "0,2.3 1.1"}, JoinFlags(outlist=((0, 0), (2, 2), (1, 0)))),
        (
            {"o": "auto", "zero_terminated": True},
            JoinFlags(autoformat=True, eol=b"\0"),
        ),
        ({"nocheck_order": True}, JoinFlags(check_order=CheckOrder.DISABLED)),
    ],
)
def test_parse_flags(flags, expected):
    assert parse_flags(flags) == expected


@pytest.mark.asyncio
async def test_cross_mount_relay_reads_every_flag():
    one, two = RAMVFS(), RAMVFS()
    await write(one.accessor, PathSpec.from_str_path("/a"), b"B 2\nx 1\n")
    await write(two.accessor, PathSpec.from_str_path("/b"), b"b y\nC z\n")
    ws = Workspace(
        {"/data": (one, MountMode.WRITE), "/data2": (two, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    io = await ws.shell(
        "join -i -j 1 -a1 -a2 -e - -o 0,1.2,2.2 "
        "--nocheck-order /data/a /data2/b"
    )
    assert (io.exit_code, await _drain(io.stdout)) == (
        0,
        b"B 2 y\nC - z\nx 1 -\n",
    )


@pytest.mark.asyncio
async def test_join_refuses_a_missing_file():
    with pytest.raises(UsageError, match="missing operand after '/a'"):
        await join([PathSpec.from_str_path("/a")], read_bytes=_drain)

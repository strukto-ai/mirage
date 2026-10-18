import asyncio
from contextlib import aclosing

import pytest

from mirage.commands.builtin.generic.join import (
    JoinFlags,
    OrderCheck,
    join,
    parse_flags,
)
from mirage.commands.errors import UsageError
from mirage.core.ram.write import write
from mirage.io.cooperative import CHUNK_SIZE
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
            JoinFlags(unpaired=(True, True), paired=False),
        ),
        ({"j": "3"}, JoinFlags(keys=(2, 2))),
        ({"t": ""}, JoinFlags(delimiter=b"\n", separator=b" ")),
        ({"t": "\\0"}, JoinFlags(delimiter=b"\0", separator=b"\0")),
        ({"o": "0,2.3 1.1"}, JoinFlags(columns=((0, 0), (2, 2), (1, 0)))),
        (
            {"o": "auto", "zero_terminated": True},
            JoinFlags(auto_columns=True, terminator=b"\0"),
        ),
        ({"nocheck_order": True}, JoinFlags(order=OrderCheck.OFF)),
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
        await join([PathSpec.from_str_path("/a")], read_stream=_drain)


@pytest.mark.parametrize(
    "flags,operands,argv,expected",
    [
        ({}, ("a", "b"), ("a", "b"), JoinFlags()),
        ({"j": "2"}, ("a", "b"), (), JoinFlags(keys=(1, 1))),
        ({"v": "2"}, ("x", "a", "b"), (), None),
    ],
)
def test_parse_flags_files_operands_without_a_tape(
    flags, operands, argv, expected
):
    if expected is None:
        with pytest.raises(UsageError, match="^join: extra operand 'b'\n"):
            parse_flags(flags, operands, argv)
    else:
        assert parse_flags(flags, operands, argv) == expected


@pytest.mark.parametrize(
    "operands,argv,message",
    [
        (("a", "b", "c"), (), "join: extra operand 'c'"),
        (("a",), (), "join: missing operand after 'a'"),
        (("a",), ("-a1", "a"), "join: missing operand after 'a'"),
    ],
)
def test_parse_flags_refuses_operands_without_a_tape(operands, argv, message):
    with pytest.raises(UsageError, match=f"^{message}\n"):
        parse_flags({}, operands, argv)


@pytest.mark.asyncio
async def test_join_hands_on_output_while_pairing_two_large_groups():
    bodies = {
        "/a": b"".join(b"k a%d\n" % i for i in range(1000)),
        "/b": b"".join(b"k b%d\n" % i for i in range(1000)),
    }

    async def read(path):
        yield bodies[path.virtual]

    source, _ = await join(
        [PathSpec.from_str_path("/a"), PathSpec.from_str_path("/b")],
        read_stream=read,
    )
    async with aclosing(source) as chunks:
        first = await anext(chunks)
    assert first.startswith(b"k a0 b0\nk a0 b1\n")
    assert len(first) < 2 * CHUNK_SIZE


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,operands,typed,other,expected",
    [
        (
            {"a": "1", "nocheck_order": True},
            ("-", "/b"),
            b"a 1\n",
            b"",
            b"a 1\n",
        ),
        ({"v": "1"}, ("-", "/b"), b"a 1\n", b"", b"a 1\n"),
        ({"a": "2"}, ("/b", "-"), b"a 1\n", b"", b"a 1\n"),
        ({"a": "1"}, ("-", "/b"), b"0 1\n", b"a x\n", b"0 1\n"),
        ({}, ("-", "/b"), b"a 1\nb 2\n", b"a x\nb y\n", b"a 1 x\n"),
    ],
    ids=[
        "rest-of-file1",
        "rest-of-file1-v",
        "rest-of-file2",
        "unpaired",
        "joined",
    ],
)
async def test_join_hands_on_output_before_waiting_for_input(
    flags, operands, typed, other, expected
):
    async def live():
        yield typed
        await asyncio.Event().wait()

    async def read(path):
        yield other

    paths = [PathSpec.from_str_path(word) for word in operands]
    source, _ = await join(
        paths,
        read_stream=read,
        stdin=live(),
        flags=parse_flags(flags),
    )
    async with aclosing(source) as chunks:
        first = await asyncio.wait_for(anext(chunks), 5)
    assert first == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,a,b",
    [
        ({"a": "1"}, b"a 1\nb 2\n\nc 3", b"a x\nc z\n"),
        ({"zero_terminated": True}, b"a 1\0b\n2\0", b"a x\0b y"),
        ({"t": ":", "header": True}, b"k:h\na:1\n", b"k:g\na:x\nb:y\n"),
    ],
)
async def test_join_reads_records_across_any_chunking(flags, a, b):

    async def run(size):
        bodies = {"/a": a, "/b": b}

        async def read(path):
            body = bodies[path.virtual]
            for at in range(0, len(body), size):
                yield body[at : at + size]

        source, io = await join(
            [PathSpec.from_str_path("/a"), PathSpec.from_str_path("/b")],
            read_stream=read,
            flags=parse_flags(flags),
        )
        out = await _drain(source)
        return out, io.exit_code, io.stderr

    whole = await run(1 << 20)
    assert whole[0]
    assert await run(1) == whole

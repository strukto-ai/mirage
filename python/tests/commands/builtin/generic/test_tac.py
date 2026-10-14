import pytest

from mirage.commands.builtin.generic.tac import tac
from mirage.types import PathSpec


def _read_stream(files: dict[str, bytes]):
    async def read_stream(path: PathSpec):
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        yield files[path.virtual]

    return read_stream


async def _drain(stdout) -> list[str]:
    if isinstance(stdout, bytes):
        return stdout.decode().splitlines()
    return b"".join([c async for c in stdout]).decode().splitlines()


@pytest.mark.asyncio
async def test_tac_stdin_reverses_lines():
    output, _ = await tac([], read_stream=_read_stream({}), stdin=b"a\nb\nc\n")
    assert await _drain(output) == ["c", "b", "a"]


@pytest.mark.asyncio
async def test_tac_file_reverses_lines():
    path = PathSpec(
        vfs_path="a.txt", virtual="/a.txt", directory="/a.txt", resolved=True
    )
    output, _ = await tac(
        [path], read_stream=_read_stream({"/a.txt": b"a\nb\nc\n"})
    )
    assert await _drain(output) == ["c", "b", "a"]


def _ranged(data: bytes, asked: list[tuple[int, int]]):
    async def read_range(path: PathSpec, *, offset: int, size: int) -> bytes:
        asked.append((offset, size))
        return data[offset : offset + size]

    return read_range


def _size(data: bytes):
    async def size_of(path: PathSpec) -> int | None:
        return len(data)

    return size_of


BIG = PathSpec(vfs_path="big", virtual="/big", directory="/", resolved=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("before", [False, True])
@pytest.mark.parametrize(
    "data",
    [
        b"a\nb\nc\n",
        b"a\nb\nc",
        b"\n\nx\n",
        b"".join(b"line %d\n" % n for n in range(40000)),
        b"x" * 100000 + b"\n" + b"y" * 70000,
    ],
)
async def test_a_ranged_tac_gives_what_a_whole_read_gives(data, before):
    whole, _ = await tac(
        [BIG], read_stream=_read_stream({BIG.virtual: data}), before=before
    )
    ranged, _ = await tac(
        [BIG],
        read_stream=_read_stream({}),
        before=before,
        read_range=_ranged(data, []),
        size_of=_size(data),
    )
    expect = b"".join([c async for c in whole])
    assert b"".join([c async for c in ranged]) == expect


@pytest.mark.asyncio
async def test_a_ranged_tac_reads_only_the_end_a_reader_pulls():
    data = b"".join(b"line %d\n" % n for n in range(400000))
    asked: list[tuple[int, int]] = []
    out, _ = await tac(
        [BIG],
        read_stream=_read_stream({}),
        read_range=_ranged(data, asked),
        size_of=_size(data),
    )
    first = await anext(out)
    assert first.startswith(b"line 399999\nline 399998\n")
    assert asked == [(len(data) - 64 * 1024, 64 * 1024)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,before,expect",
    [
        (b"a|b|c|", True, b"||c|ba"),
        (b"a|b|c|", False, b"c|b|a|"),
        (b"\xff\xfe|\x80|", False, b"\x80|\xff\xfe|"),
    ],
)
async def test_tac_keeps_bytes_and_puts_b_before_the_record(
    data, before, expect
):
    out, _ = await tac(
        [],
        read_stream=_read_stream({}),
        stdin=data,
        separator="|",
        before=before,
    )
    got = out if isinstance(out, bytes) else b"".join([c async for c in out])
    assert got == expect

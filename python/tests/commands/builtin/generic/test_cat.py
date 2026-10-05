import pytest

from mirage.commands.builtin.generic.cat import (
    CatFlags,
    cat_generic,
    display_lines,
)
from mirage.commands.config import CommandOpts
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import efbig


async def _drain(gen):
    return b"".join([c async for c in gen])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,flags,expected",
    [
        (bytes(range(256)), {}, bytes(range(256))),
        (
            b"a\n\n\n\nb\n",
            {"number_lines": True, "show_ends": True, "squeeze_blank": True},
            b"     1\ta$\n     2\t$\n     3\tb$\n",
        ),
    ],
)
async def test_cat_renders_bytes(data, flags, expected):
    assert await _drain(display_lines(data, CatFlags(**flags))) == expected


@pytest.mark.asyncio
async def test_cat_number_lines_chunked_one_byte_at_a_time():
    """Worst-case chunking: every byte its own chunk. Result must match
    unbuffered input exactly."""

    async def src():
        for byte in b"a\nbb\nccc\n":
            yield bytes([byte])

    out = await _drain(display_lines(src(), CatFlags(number_lines=True)))
    assert out == b"     1\ta\n     2\tbb\n     3\tccc\n"


@pytest.mark.asyncio
async def test_cat_generic_reports_a_refused_read_and_goes_on():
    """A table past its read cap stats fine and refuses the read; GNU cat
    reports the operand and prints the next one."""
    files = {"/a.txt": None, "/b.txt": b"b1\nb2\n"}

    async def stat(p: PathSpec) -> FileStat:
        return FileStat(name=p.virtual, type=FileType.FILE)

    async def read(p: PathSpec):
        if files[p.virtual] is None:
            raise efbig(p)
        yield files[p.virtual]

    paths = [PathSpec.from_str_path(p) for p in files]
    out, io = await cat_generic(
        paths, [], CommandOpts(), stat, read, local=False
    )
    assert await materialize(out) == b"b1\nb2\n"
    assert io.stderr == b"cat: /a.txt: File too large\n"
    assert io.exit_code == 1
    assert list(io.reads) == ["/b.txt"]

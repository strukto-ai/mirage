from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.column import column_generic
from mirage.commands.config import Context
from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.io.types import materialize
from mirage.types import PathSpec


@pytest.mark.asyncio
@pytest.mark.parametrize("streamed", [False, True])
async def test_column_accepts_bytes_and_streams(streamed):
    async def pieces():
        for byte in b"a 1\nlong 2\n":
            yield bytes([byte])

    def read(path):
        return pieces() if streamed else b"a 1\nlong 2\n"

    out, io = await column_generic(
        [PathSpec.from_str_path("/f")],
        [],
        Context(flags={"table": True}),
        read,
    )
    assert await materialize(out) == b"a     1\nlong  2\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_column_feeds_large_operands_without_host_materialization():
    block = b" " * 16383 + b"\n"
    read_bytes = 0

    async def read(path) -> AsyncIterator[bytes]:
        nonlocal read_bytes
        for _ in range(2176):
            read_bytes += len(block)
            yield block

    async def run():
        out, io = await column_generic(
            [PathSpec.from_str_path("/f")],
            [],
            Context(flags={"table": True}),
            read,
        )
        assert await materialize(out) == b""
        assert io.exit_code == 0

    await run_with_memory(MemoryBudget(32 << 20, lambda: 0), run())
    assert read_bytes == 34 << 20


async def _column(
    words: list[str], body: bytes = b"a 1\nlong 2\n"
) -> tuple[bytes, bytes, int]:
    parsed = parse_command(SPECS["column"], words, "/", "column")
    out, io = await column_generic(
        [],
        [],
        Context(flags=parse_to_kwargs(parsed), stdin=body),
        lambda path: b"",
    )
    data = b"" if out is None else await materialize(out)
    return data, await materialize(io.stderr), io.exit_code


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, stdout",
    [
        (
            ["--table", "--table-columns", "A,B"],
            b"A     B\na     1\nlong  2\n",
        ),
        (["-t", "-R", "2", "-N", "A,B"], b"A     B\na     1\nlong  2\n"),
        (["-t", "--table-hide", "1"], b"1\n2\n"),
        (["-t", "--table-order", "2"], b"1  a\n2  long\n"),
        (["-t", "--table-columns-limit", "1"], b"a 1\nlong 2\n"),
        (["--fillrows", "--output-width", "20"], b"a 1\tlong 2\n"),
        (
            ["--json", "--table-name", "t", "-N", "A,B"],
            b'{\n   "t": [\n      {\n         "a": "a",\n         "b": "1"\n'
            b'      },{\n         "a": "long",\n         "b": "2"\n'
            b"      }\n   ]\n}\n",
        ),
    ],
)
async def test_column_reads_its_table_options(
    words: list[str], stdout: bytes
) -> None:
    assert await _column(words) == (stdout, b"", 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "words, stderr",
    [
        (["-c", "abc"], b"column: invalid columns argument: 'abc'\n"),
        (["-N", "A"], b"column: option --table required for all --table-*\n"),
        (["-t", "-R", "9"], b"column: undefined column name '9'\n"),
    ],
)
async def test_column_refuses_as_the_real_one_does(
    words: list[str], stderr: bytes
) -> None:
    assert await _column(words) == (b"", stderr, 1)

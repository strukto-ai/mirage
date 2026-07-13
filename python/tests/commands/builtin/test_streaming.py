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

import pytest

from mirage.accessor import NOOPAccessor
from mirage.commands import COMMANDS as _CMDS
from mirage.types import PathSpec

_ps = PathSpec.from_str_path

cat = _CMDS["cat"]
cut = _CMDS["cut"]
grep = _CMDS["grep"]
head = _CMDS["head"]
nl = _CMDS["nl"]
tr = _CMDS["tr"]
uniq = _CMDS["uniq"]
wc = _CMDS["wc"]

_NOOP = NOOPAccessor()


async def _chunks(parts: list[bytes]):
    for p in parts:
        yield p


# --- cat ---


@pytest.mark.asyncio
async def test_cat_file_returns_async_iterator(backend):
    await backend.write(_ps("/tmp/f.txt"), data=b"hello world")
    stdout, io = await cat(backend.accessor, [_ps("/tmp/f.txt")])
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"hello world"


@pytest.mark.asyncio
async def test_cat_stdin_returns_async_iterator():
    source = _chunks([b"hello ", b"world"])
    stdout, io = await cat(_NOOP, [], stdin=source)
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"hello world"


@pytest.mark.asyncio
async def test_cat_bytes_stdin():
    stdout, io = await cat(_NOOP, [], stdin=b"hello")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"hello"


@pytest.mark.asyncio
async def test_cat_number_lines(backend):
    await backend.write(_ps("/tmp/f.txt"), data=b"aaa\nbbb\n")
    stdout, io = await cat(backend.accessor, [_ps("/tmp/f.txt")], n=True)
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert b"1" in collected
    assert b"aaa" in collected
    assert b"2" in collected
    assert b"bbb" in collected


# --- grep ---


@pytest.mark.asyncio
async def test_grep_file_returns_async_iterator(backend):
    await backend.write(_ps("/tmp/f.txt"),
                        data=b"apple\nbanana\napricot\ncherry\n")
    stdout, io = await grep(backend.accessor, [_ps("/tmp/f.txt")], "ap")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert b"apple" in collected
    assert b"apricot" in collected
    assert b"banana" not in collected


@pytest.mark.asyncio
async def test_grep_stdin_streaming():
    source = _chunks([b"apple\nban", b"ana\napricot\ncherry\n"])
    stdout, io = await grep(_NOOP, [], "ap", stdin=source)
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert b"apple" in collected
    assert b"apricot" in collected
    assert b"banana" not in collected


@pytest.mark.asyncio
async def test_grep_max_count_stops_early():
    pull_count = 0

    async def _counting():
        nonlocal pull_count
        for i in range(10000):
            pull_count += 1
            yield f"match_line_{i}\n".encode()

    stdout, io = await grep(_NOOP, [], "match", stdin=_counting(), m="3")
    collected = b"".join([chunk async for chunk in stdout])
    lines = collected.strip().split(b"\n")
    assert len(lines) == 3
    assert pull_count < 100


@pytest.mark.asyncio
async def test_grep_no_match_exit_code():
    source = _chunks([b"apple\nbanana\n"])
    stdout, io = await grep(_NOOP, [], "zzz", stdin=source)
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b""


@pytest.mark.asyncio
async def test_grep_ignore_case():
    source = _chunks([b"Apple\nBANANA\napricot\n"])
    stdout, io = await grep(_NOOP, [], "ap", stdin=source, i=True)
    collected = b"".join([chunk async for chunk in stdout])
    assert b"Apple" in collected
    assert b"apricot" in collected
    assert b"BANANA" not in collected


@pytest.mark.asyncio
async def test_grep_invert():
    source = _chunks([b"apple\nbanana\ncherry\n"])
    stdout, io = await grep(_NOOP, [], "banana", stdin=source, v=True)
    collected = b"".join([chunk async for chunk in stdout])
    assert b"apple" in collected
    assert b"cherry" in collected
    assert b"banana" not in collected


@pytest.mark.asyncio
async def test_grep_count_only():
    source = _chunks([b"apple\nbanana\napricot\n"])
    stdout, io = await grep(_NOOP, [], "ap", stdin=source, c=True)
    collected = b"".join([chunk async for chunk in stdout])
    assert collected.strip() == b"2"


# --- head ---


@pytest.mark.asyncio
async def test_head_file_returns_async_iterator(backend):
    lines = b"\n".join(f"line{i}".encode() for i in range(20))
    await backend.write(_ps("/tmp/f.txt"), data=lines)
    stdout, io = await head(backend.accessor, [_ps("/tmp/f.txt")], n="3")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"line0\nline1\nline2\n"


@pytest.mark.asyncio
async def test_head_stdin_streaming():
    source = _chunks([b"a\nb\nc\nd\ne\n"])
    stdout, io = await head(_NOOP, [], stdin=source, n="2")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"a\nb\n"


@pytest.mark.asyncio
async def test_head_early_termination():
    pull_count = 0

    async def _infinite():
        nonlocal pull_count
        for i in range(100000):
            pull_count += 1
            yield f"line{i}\n".encode()

    stdout, io = await head(_NOOP, [], stdin=_infinite(), n="3")
    collected = b"".join([chunk async for chunk in stdout])
    lines = collected.strip().split(b"\n")
    assert len(lines) == 3
    assert pull_count < 20


@pytest.mark.asyncio
async def test_head_default_10_lines():
    data = b"\n".join(f"line{i}".encode() for i in range(20)) + b"\n"
    source = _chunks([data])
    stdout, io = await head(_NOOP, [], stdin=source)
    collected = b"".join([chunk async for chunk in stdout])
    assert collected.count(b"\n") == 10


@pytest.mark.asyncio
async def test_head_bytes_mode():
    source = _chunks([b"hello world, this is a long string"])
    stdout, io = await head(_NOOP, [], stdin=source, c="5")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"hello"


# --- cut ---


@pytest.mark.asyncio
async def test_cut_stdin_streaming():
    source = _chunks([b"a,b,c\nd,e,f\n"])
    stdout, io = await cut(_NOOP, [], stdin=source, d=",", f="2")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"b\ne\n"


@pytest.mark.asyncio
async def test_cut_file_returns_async_iterator(backend):
    await backend.write(_ps("/tmp/f.txt"), data=b"a,b,c\nd,e,f\n")
    stdout, io = await cut(backend.accessor, [_ps("/tmp/f.txt")], d=",", f="2")
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"b\ne\n"


# --- uniq ---


@pytest.mark.asyncio
async def test_uniq_stdin_streaming():
    source = _chunks([b"a\na\nb\nb\nb\nc\n"])
    stdout, io = await uniq(_NOOP, [], stdin=source)
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_uniq_count():
    source = _chunks([b"a\na\nb\n"])
    stdout, io = await uniq(_NOOP, [], stdin=source, c=True)
    collected = b"".join([chunk async for chunk in stdout])
    assert b"2" in collected
    assert b"a" in collected


# --- nl ---


@pytest.mark.asyncio
async def test_nl_stdin_streaming():
    source = _chunks([b"aaa\nbbb\nccc\n"])
    stdout, io = await nl(_NOOP, [], stdin=source)
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert b"1" in collected
    assert b"aaa" in collected


# --- tr ---


@pytest.mark.asyncio
async def test_tr_stdin_streaming():
    source = _chunks([b"hello world"])
    stdout, io = await tr(_NOOP, [], "o", "0", stdin=source)
    assert hasattr(stdout, "__aiter__")
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"hell0 w0rld"


@pytest.mark.asyncio
async def test_tr_delete():
    source = _chunks([b"hello world"])
    stdout, io = await tr(_NOOP, [], "lo", stdin=source, d=True)
    collected = b"".join([chunk async for chunk in stdout])
    assert collected == b"he wrd"


# --- wc ---


@pytest.mark.asyncio
async def test_wc_lines_streaming():
    source = _chunks([b"a\nb\nc\n"])
    stdout, io = await wc(_NOOP, [], stdin=source, args_l=True)
    collected = b"".join([chunk async for chunk in stdout]) if hasattr(
        stdout, "__aiter__") else stdout
    assert b"3" in collected


@pytest.mark.asyncio
async def test_wc_full_streaming():
    source = _chunks([b"one two\nthree\n"])
    stdout, io = await wc(_NOOP, [], stdin=source)
    collected = b"".join([chunk async for chunk in stdout]) if hasattr(
        stdout, "__aiter__") else stdout
    assert b"2" in collected  # lines
    assert b"3" in collected  # words

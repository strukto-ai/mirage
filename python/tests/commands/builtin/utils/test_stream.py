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

from mirage.commands.builtin.utils.stream import (
    is_stdin,
    operand_label,
    stdin_stat,
    stdin_stream,
    stream_output,
)
from mirage.rs.stream import open_stream
from mirage.types import FileStat, FileType, PathSpec


def _operand(raw: str, virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"),
        virtual=virtual,
        directory="/",
        resolved=True,
        raw_path=raw,
    )


def test_operand_label_names_only_a_dash_stdin():
    # GNU grep, head and tail call only `-` standard input: /dev/stdin
    # reads the same bytes and is named as the path it is.
    dash = _operand("-", "/-")
    dev = _operand("/dev/stdin", "/dev/stdin")
    assert (is_stdin(dash), is_stdin(dev)) == (True, True)
    assert operand_label(dash, "(standard input)") == "(standard input)"
    assert operand_label(dev, "(standard input)") == "/dev/stdin"
    assert operand_label(_operand("a.txt", "/data/a.txt"), "-") == "a.txt"


def test_dash_false_keeps_a_dash_a_file_and_dev_stdin_stdin():
    # util-linux rev and binutils strings open `-` as a path; only
    # /dev/stdin reads stdin for them.
    dash = _operand("-", "/-")
    dev = _operand("/dev/stdin", "/dev/stdin")
    assert (is_stdin(dash, dash=False), is_stdin(dev, dash=False)) == (
        False,
        True,
    )


@pytest.mark.asyncio
async def test_stdin_stat_and_stream_honor_dash():
    backend_hits: list[str] = []

    async def stat(path: PathSpec) -> FileStat:
        backend_hits.append(path.virtual)
        return FileStat(name="-", type=FileType.FILE)

    async def read(path: PathSpec) -> bytes:
        backend_hits.append(path.virtual)
        return b"backend"

    dash = _operand("-", "/-")
    dev = _operand("/dev/stdin", "/dev/stdin")
    probe = stdin_stat(stat, dash=False)
    assert (await probe(dev)).type == FileType.FIFO
    assert (await probe(dash)).type == FileType.FILE
    stream = stdin_stream(read, b"piped", dash=False)
    assert b"".join([c async for c in stream(dev)]) == b"piped"
    assert b"".join([c async for c in stream(dash)]) == b"backend"
    assert backend_hits == ["/-", "/-"]


@pytest.mark.asyncio
async def test_unstarted_output_closes_its_source_without_pulling():
    class Source:
        def __init__(self):
            self.closed = 0

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise AssertionError("unstarted output pulled input")

        async def aclose(self):
            self.closed += 1

    source = Source()
    output = stream_output(
        open_stream("base64", {"mode": "decode", "ignore_garbage": False}),
        source,
    )
    await output.aclose()
    await output.aclose()
    assert source.closed == 1

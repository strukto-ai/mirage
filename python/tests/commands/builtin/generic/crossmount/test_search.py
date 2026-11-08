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

from contextlib import aclosing
from typing import Any

import pytest

from mirage.commands.builtin.generic.crossmount.search import run_search
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec


async def _file(
    op: str, path: PathSpec, **_: Any
) -> tuple[FileStat, IOResult]:
    name = path.virtual.rsplit("/", 1)[-1]
    return FileStat(name=name, type=FileType.FILE), IOResult()


async def _reporting_run(cmd, operands, words, bag, stdin=None):
    async def out():
        yield f"{operands[0].virtual}:x\n".encode()
        yield f"{operands[0].virtual}:xx\n".encode()

    return out(), IOResult(
        stderr=b"grep: /m1/c: Permission denied\n", exit_code=2
    )


@pytest.mark.asyncio
async def test_a_reader_that_stops_inside_a_run_keeps_what_it_reported():
    paths = [PathSpec.from_str_path("/m1/a"), PathSpec.from_str_path("/m2/b")]
    stream, io = await run_search(
        "grep", paths, ["x"], {}, _file, _reporting_run, "/"
    )
    async with aclosing(stream) as output:
        assert await anext(output) == b"/m1/a:x\n"
    assert io.stderr == b"grep: /m1/c: Permission denied\n"
    assert io.exit_code == 2

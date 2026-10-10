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

import asyncio

from mirage.commands.builtin.generic_bind.adapter import command_io
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.commands.config import CommandOpts
from mirage.core.ram.stream import read_stream
from mirage.core.ram.write import write
from mirage.types import PathSpec

_CMDS = GENERIC_COMMANDS
cp_cmd = _CMDS.require("cp").fn


def _cat_sync(backend, path):
    async def _collect():
        return b"".join([c async for c in read_stream(backend.accessor, path)])

    return asyncio.run(_collect())


def test_cp_recursive(backend):
    store = backend.accessor.store
    accessor = backend.accessor
    store.dirs.add("/tmp/src")
    store.dirs.add("/tmp/src/sub")
    asyncio.run(
        write(accessor, PathSpec.from_str_path("/tmp/src/a.txt"), b"aaa")
    )
    asyncio.run(
        write(accessor, PathSpec.from_str_path("/tmp/src/sub/b.txt"), b"bbb")
    )
    asyncio.run(
        cp_cmd(
            accessor,
            [
                PathSpec.from_str_path("/tmp/src/"),
                PathSpec.from_str_path("/tmp/dst/"),
            ],
            [],
            CommandOpts(io=command_io(backend), flags={"r": True}),
        )
    )
    assert (
        _cat_sync(backend, PathSpec.from_str_path("/tmp/dst/a.txt")) == b"aaa"
    )
    assert (
        _cat_sync(backend, PathSpec.from_str_path("/tmp/dst/sub/b.txt"))
        == b"bbb"
    )

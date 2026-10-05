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

import base64

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.generic_bind.builders.unzip import unzip
from mirage.commands.builtin.ram.io import IO
from mirage.commands.config import CommandOpts
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read
from mirage.core.ram.write import write
from mirage.types import PathSpec
from mirage.vfs.ram.store import RAMStore

# a/b.txt ("first"), then a/../b.txt ("second"), which Info-ZIP maps onto
# the same path.
ARCHIVE = base64.b64decode(
    "UEsDBBQAAAAAAAAAIVwqs0rHBgAAAAYAAAAHAAAAYS9iLnR4dGZpcnN0ClBLAwQUAAAAAAAAACFcfsAPBgcAAAAHAAAACgAAAGEvLi4vYi50eHRzZWNvbmQKUEsBAhQDFAAAAAAAAAAhXCqzSscGAAAABgAAAAcAAAAAAAAAAAAAAIABAAAAAGEvYi50eHRQSwECFAMUAAAAAAAAACFcfsAPBgcAAAAHAAAACgAAAAAAAAAAAAAAgAErAAAAYS8uLi9iLnR4dFBLBQYAAAAAAgACAG0AAABaAAAAAAA="
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,kept,asked",
    [
        ({}, b"first\n", True),
        ({"n": True}, b"first\n", False),
        ({"o": True}, b"second\n", False),
    ],
    ids=["asks", "never", "overwrite"],
)
async def test_unzip_without_a_dispatcher_sees_a_member_it_just_wrote(
    flags, kept, asked
):
    """Without a dispatcher the builder hands the generic the mount's own
    stat, and a member mapped onto one already written is asked about,
    kept under -n and replaced under -o, as Info-ZIP does."""
    accessor = RAMAccessor(RAMStore())
    await write(accessor, PathSpec.from_str_path("/m.zip"), ARCHIVE)
    _, io = await unzip(
        IO,
        accessor,
        [PathSpec.from_str_path("/m.zip")],
        [],
        CommandOpts(flags=flags),
    )
    assert await read(accessor, PathSpec.from_str_path("/a/b.txt")) == kept
    assert io.exit_code == 1
    stderr = bytes(io.stderr or b"")
    assert (b"replace a/b.txt?" in stderr) is asked


@pytest.mark.asyncio
async def test_unzip_without_a_dispatcher_never_replaces_a_file_under_n():
    """-n asks the mount's stat, so a file there before the run stays."""
    accessor = RAMAccessor(RAMStore())
    await write(accessor, PathSpec.from_str_path("/m.zip"), ARCHIVE)
    await mkdir(accessor, PathSpec.from_str_path("/a"))
    await write(accessor, PathSpec.from_str_path("/a/b.txt"), b"old\n")
    _, io = await unzip(
        IO,
        accessor,
        [PathSpec.from_str_path("/m.zip")],
        [],
        CommandOpts(flags={"n": True}),
    )
    assert await read(accessor, PathSpec.from_str_path("/a/b.txt")) == b"old\n"
    assert io.exit_code == 1

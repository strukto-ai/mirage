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

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import run_on_mount

# a/b.txt ("first"), then a/../b.txt ("second"), which Info-ZIP maps onto
# the same path.
ARCHIVE = base64.b64decode(
    "UEsDBBQAAAAAAAAAIVwqs0rHBgAAAAYAAAAHAAAAYS9iLnR4dGZpcnN0ClBLAwQUAAAAAAAAACFcfsAPBgcAAAAHAAAACgAAAGEvLi4vYi50eHRzZWNvbmQKUEsBAhQDFAAAAAAAAAAhXCqzSscGAAAABgAAAAcAAAAAAAAAAAAAAIABAAAAAGEvYi50eHRQSwECFAMUAAAAAAAAACFcfsAPBgcAAAAHAAAACgAAAAAAAAAAAAAAgAErAAAAYS8uLi9iLnR4dFBLBQYAAAAAAgACAG0AAABaAAAAAAA="
)


def _ws(files: dict[str, bytes]) -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.dirs.add("/")
    vfs._store.files.update(files)
    if any(name.startswith("/a/") for name in files):
        vfs._store.dirs.add("/a")
    return Workspace({"/": (vfs, MountMode.WRITE)}), vfs


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
async def test_unzip_sees_a_member_it_just_wrote(flags, kept, asked):
    """A member mapped onto one already written is asked about, kept
    under -n and replaced under -o, as Info-ZIP does."""
    ws, vfs = _ws({"/m.zip": ARCHIVE})
    _, io = await run_on_mount(
        ws, "unzip", [PathSpec.from_str_path("/m.zip")], flags=flags
    )
    assert vfs._store.files["/a/b.txt"] == kept
    assert io.exit_code == 1
    stderr = bytes(io.stderr or b"")
    assert (b"replace a/b.txt?" in stderr) is asked


@pytest.mark.asyncio
async def test_unzip_never_replaces_a_file_under_n():
    """-n asks the stat, so a file there before the run stays."""
    ws, vfs = _ws({"/m.zip": ARCHIVE, "/a/b.txt": b"old\n"})
    _, io = await run_on_mount(
        ws, "unzip", [PathSpec.from_str_path("/m.zip")], flags={"n": True}
    )
    assert vfs._store.files["/a/b.txt"] == b"old\n"
    assert io.exit_code == 1

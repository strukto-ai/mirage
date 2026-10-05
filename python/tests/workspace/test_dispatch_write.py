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
import errno

import pytest

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _make_ws() -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.files["/file.txt"] = b"OLD"
    ws = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, vfs


def test_redirect_write_overrides_cached_read():
    ws, vfs = _make_ws()

    async def run() -> None:
        await ws.shell("cat /data/file.txt")
        await ws.shell('echo -n "NEW" > /data/file.txt')

    asyncio.run(run())
    assert vfs._store.files["/file.txt"] == b"NEW", (
        "redirect-write should reach the backend even when the path was "
        "previously cached by a read"
    )


def test_redirect_append_after_cached_read():
    ws, vfs = _make_ws()

    async def run() -> None:
        await ws.shell("cat /data/file.txt")
        await ws.shell('echo -n "MORE" >> /data/file.txt')

    asyncio.run(run())
    assert vfs._store.files["/file.txt"] == b"OLDMORE", (
        "redirect-append should reach the backend even when the path was "
        "previously cached by a read"
    )


@pytest.mark.parametrize("src", ["/a/x.txt", "/a/missing.txt"])
def test_dispatch_rename_across_mounts_is_exdev(src):
    # Mirrors the TypeScript dispatcher test. A mount is a filesystem
    # boundary, so rename(2) answers EXDEV across two before it looks the
    # source up, and nothing moves: the source's backend never takes
    # "/b/y.txt" for one of its own keys.
    ws = Workspace(
        {
            "/a": (RAMVFS(), MountMode.WRITE),
            "/b": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )

    async def run() -> None:
        await ws.shell("echo moved-bytes > /a/x.txt")
        with pytest.raises(OSError) as exc:
            await ws.dispatch(
                "rename",
                PathSpec.from_str_path(src),
                dst=PathSpec.from_str_path("/b/y.txt"),
            )
        assert exc.value.errno == errno.EXDEV
        assert (await ws.shell("cat /a/x.txt")).stdout == b"moved-bytes\n"
        assert (await ws.shell("cat /a/b/y.txt")).exit_code != 0
        assert (await ws.shell("cat /b/y.txt")).exit_code != 0

    asyncio.run(run())

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

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


def _make_ws() -> tuple[Workspace, RAMResource]:
    resource = RAMResource()
    resource._store.files["/file.txt"] = b"OLD"
    ws = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, resource


def test_redirect_write_overrides_cached_read():
    ws, resource = _make_ws()

    async def run() -> None:
        await ws.execute("cat /data/file.txt")
        await ws.execute('echo -n "NEW" > /data/file.txt')

    asyncio.run(run())
    assert resource._store.files["/file.txt"] == b"NEW", (
        "redirect-write should reach the backend even when the path was "
        "previously cached by a read")


def test_redirect_append_after_cached_read():
    ws, resource = _make_ws()

    async def run() -> None:
        await ws.execute("cat /data/file.txt")
        await ws.execute('echo -n "MORE" >> /data/file.txt')

    asyncio.run(run())
    assert resource._store.files["/file.txt"] == b"OLDMORE", (
        "redirect-append should reach the backend even when the path was "
        "previously cached by a read")


def test_dispatch_rename_addresses_dst_against_the_source_mount():
    # Mirrors the TypeScript dispatcher test. Both languages execute the
    # rename on the source backend and address the dst key against it, so
    # "/b/y.txt" means "b/y.txt" inside /a, a directory that does not
    # exist there. The store-backed backends refuse (rename(2) ENOENT)
    # instead of growing an orphan key under a directory they never
    # recorded. Neither language crosses mounts.
    ws = Workspace(
        {
            "/a": (RAMResource(), MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )

    async def run() -> None:
        await ws.execute("echo moved-bytes > /a/x.txt")
        with pytest.raises(FileNotFoundError):
            await ws.dispatch("rename",
                              PathSpec.from_str_path("/a/x.txt"),
                              dst=PathSpec.from_str_path("/b/y.txt"))
        assert (await ws.execute("cat /a/x.txt")).stdout == b"moved-bytes\n"
        assert (await ws.execute("cat /a/b/y.txt")).exit_code != 0
        assert (await ws.execute("cat /b/y.txt")).exit_code != 0

    asyncio.run(run())

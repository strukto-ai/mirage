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

import errno

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.ops.boundary import OpBoundary
from mirage.policy import Policies
from mirage.types import MountMode, PathSpec
from mirage.utils.errors import ReadOnlyError
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.mount.mount import MountEntry


def _entry(prefix: str, mode: MountMode) -> MountEntry:
    return MountEntry(prefix, RAMVFS(), mode=mode)


def _path(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


async def _admit(mount: MountEntry | None, path: PathSpec) -> None:
    # The dispatcher's own boundary: an owned path carries its mount's
    # prefix and mode, an unowned one an empty prefix and full write.
    boundary = OpBoundary(
        Policies(),
        mount.prefix if mount is not None else "",
        mount.mode if mount is not None else MountMode.WRITE,
    )
    await boundary.admit("symlink", path, True, create=True)


@pytest.mark.asyncio
async def test_mount_mode_governs_namespace_writes():
    await _admit(_entry("/data/", MountMode.WRITE), _path("/data/lk"))
    with pytest.raises(ReadOnlyError):
        await _admit(_entry("/ro/", MountMode.READ), _path("/ro/lk"))


@pytest.mark.asyncio
async def test_an_unowned_path_is_writable_without_a_session():
    await _admit(None, _path("/toplink"))


@pytest.mark.asyncio
async def test_a_session_grant_narrows_an_owned_path():
    # The grant is what binds: it says what this session may do, which
    # covers the namespace plane as well as the backend one, so a grant
    # that stops a file write at /extra stops the table write too.
    ws = Workspace({"/extra": (RAMVFS(), MountMode.WRITE)})
    entry = ws.namespace.try_mount_for("/extra/lk")
    sess = ws.create_session("agent", mounts={"/extra/": "read"})
    token = set_current_session(sess)
    try:
        with pytest.raises(ReadOnlyError):
            await _admit(entry, _path("/extra/lk"))
    finally:
        reset_current_session(token)
    await _admit(entry, _path("/extra/lk"))


@pytest.mark.asyncio
async def test_a_root_statement_governs_an_unowned_path():
    # "Above every mount" is governed by "/": a profile that caps the
    # root to read refuses the table write there, with no mount at /.
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)})
    sess = ws.create_session("agent", mounts={"/": "read"})
    token = set_current_session(sess)
    try:
        with pytest.raises(ReadOnlyError) as exc:
            await _admit(None, _path("/toplink"))
        assert exc.value.errno == errno.EROFS
    finally:
        reset_current_session(token)

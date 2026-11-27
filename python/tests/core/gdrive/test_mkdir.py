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

from mirage.core.gdrive.mkdir import mkdir
from mirage.core.gdrive.readdir import readdir
from mirage.core.google.drive import FOLDER_MIME
from mirage.types import MountMode, PathSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.fixtures.handed import call


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_mkdir_creates(google_account):
    await call(mkdir, readdir, google_account.drive_accessor(), spec("/d"))
    item = await google_account.find("d")
    assert item is not None
    assert item["mimeType"] == FOLDER_MIME


@pytest.mark.asyncio
async def test_mkdir_missing_parent_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await call(
            mkdir, readdir, google_account.drive_accessor(), spec("/no/d")
        )


def _workspace(google_account) -> Workspace:
    vfs = GoogleDriveVFS(config=google_account.config(GoogleDriveConfig))
    return Workspace({"/d/": vfs}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_mkdir_parents_builds_chain(google_account):
    # -p is the mount's: it makes one level at a time, each handed the
    # folder the level above answered.
    ws = _workspace(google_account)
    try:
        await ws.dispatch("mkdir", spec("/d/a/b/c"), parents=True)
        a = await google_account.find("a")
        b = await google_account.find("b")
        c = await google_account.find("c")
        assert a and b and c
        assert b["parents"] == [a["id"]]
        assert c["parents"] == [b["id"]]
        # Idempotent under -p.
        await ws.dispatch("mkdir", spec("/d/a/b/c"), parents=True)
        assert len(await google_account.items()) == 3
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_mkdir_parents_over_file(google_account):
    await google_account.upload("f.txt", b"x")
    ws = _workspace(google_account)
    try:
        with pytest.raises(FileExistsError):
            await ws.dispatch("mkdir", spec("/d/f.txt"), parents=True)
        with pytest.raises(NotADirectoryError):
            await ws.dispatch("mkdir", spec("/d/f.txt/sub"), parents=True)
    finally:
        await ws.close()

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

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from tests.e2e.gdrive_mock import FakeGDrive, patch_gdrive


def test_gdrive_cannot_declare_fresh():
    """gdrive stamps two different kinds of token, so it is refused.

    This test used to assert that gdrive under `fresh` refetched after a
    modifiedTime change. It passed because the fake made the two tokens
    agree; the real backend stamps a timestamp on stat
    (core/gdrive/stat.py) and an md5 on read (core/gdrive/versions.py),
    so the comparison could never match and every read would evict and
    refetch. Aligning them is an E-series change; until then the mount
    is refused rather than allowed to pay the cost for no signal.
    """
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    with pytest.raises(ValueError) as exc:
        Workspace(
            {"/gd": (GoogleDriveVFS(config), MountMode.WRITE)},
            mode=MountMode.WRITE,
            read=ReadSpec(policy=ReadPolicy.FRESH),
        )
    assert "comparable content token" in str(exc.value)


@pytest.mark.asyncio
async def test_gdrive_bounded_may_serve_stale():
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    vfs = GoogleDriveVFS(config)
    ws = Workspace(
        {"/gd": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
    )
    with patch_gdrive(fake):
        await ws.shell("ls /gd")
        io1 = await ws.shell("cat /gd/file.txt")
        assert (await io1.materialize_stdout()) == b"v1"

        fake.add_file("file.txt", b"v2-external")

        io2 = await ws.shell("cat /gd/file.txt")
        got = await io2.materialize_stdout()
        assert got in (b"v1", b"v2-external"), (
            "LAZY allowed to serve cache; just confirming no crash")

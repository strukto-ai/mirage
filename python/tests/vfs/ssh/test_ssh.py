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

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig
from mirage.vfs.ssh.ssh import SSHVFS


def _location(username: str, root: str) -> str | None:
    config = SSHConfig(host="box", username=username, root=root)
    return SSHVFS(config).storage_location()


def test_two_logins_to_one_root_are_one_store():
    assert _location("ada", "/srv/data") == _location("bob", "/srv/data/")
    assert _location("ada", "/srv/data") != _location("ada", "/srv")


def test_a_relative_root_is_each_logins_own():
    assert _location("ada", "data") != _location("bob", "data")
    assert _location("ada", "data") == _location("ada", "data/")


# The mount asks for an atomic write of bytes as it does of a stream, and
# either is staged and renamed into place whole.
@pytest.mark.asyncio
async def test_an_atomic_write_of_bytes_is_staged():
    handle = AsyncMock()
    handle.__aenter__.return_value = handle
    sftp = Mock(
        stat=AsyncMock(return_value=SimpleNamespace(permissions=0o100640)),
        open=AsyncMock(return_value=handle),
        chmod=AsyncMock(),
        posix_rename=AsyncMock(),
        remove=AsyncMock(),
    )
    vfs = SSHVFS(SSHConfig(host="box", root="/srv"))
    vfs.accessor._sftp = sftp
    path = PathSpec(vfs_path="a", virtual="/m/a", directory="/m/")
    await vfs.write(path, b"new", atomic=True)
    staged = sftp.open.call_args.args[0]
    assert staged != "/srv/a"
    sftp.posix_rename.assert_awaited_once_with(staged, "/srv/a")

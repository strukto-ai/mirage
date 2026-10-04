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

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.constants import FXF_CREAT, FXF_WRITE
from mirage.core.ssh.pwrite import pwrite
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig


class _FakeFile:
    def __init__(self, sftp: "_FakeSFTP", path: str) -> None:
        self.sftp = sftp
        self.path = path

    async def __aenter__(self) -> "_FakeFile":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def write(self, data: bytes, offset: int | None = None) -> int:
        self.sftp.writes.append((self.path, data, offset))
        return len(data)


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for pwrite."""

    def __init__(self) -> None:
        self.opens: list[tuple[str, int, str | None]] = []
        self.writes: list[tuple[str, bytes, int | None]] = []

    async def open(
        self, path: str, pflags: int, encoding: str | None
    ) -> _FakeFile:
        self.opens.append((path, pflags, encoding))
        return _FakeFile(self, path)


@pytest.mark.asyncio
async def test_pwrite_writes_at_the_offset_without_truncating():
    accessor = SSHAccessor(SSHConfig(host="example.test", root="/srv"))
    fake = _FakeSFTP()
    accessor._sftp = fake
    path = PathSpec(vfs_path="f.txt", virtual="/r/f.txt", directory="/r/")
    await pwrite(accessor, path, b"XY", 4)
    assert fake.opens == [("/srv/f.txt", FXF_WRITE | FXF_CREAT, None)]
    assert fake.writes == [("/srv/f.txt", b"XY", 4)]

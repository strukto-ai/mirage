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
from mirage.core.ssh.write import write_bytes
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig
from tests.fixtures.settle import Settled, settling


class _FakeFile:
    def __init__(self, files: dict[str, bytes], remote: str) -> None:
        self.files = files
        self.remote = remote

    async def __aenter__(self) -> "_FakeFile":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def write(self, data: bytes) -> None:
        self.files[self.remote] = data


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for a whole-file write."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    def open(self, remote: str, mode: str) -> _FakeFile:
        return _FakeFile(self.files, remote)


def _accessor(sftp: _FakeSFTP) -> SSHAccessor:
    accessor = SSHAccessor(SSHConfig(host="example.test"))
    accessor._sftp = sftp
    return accessor


@pytest.mark.asyncio
async def test_write_settles_its_bytes_without_a_receipt():
    sftp = _FakeSFTP()
    with settling() as manager:
        await write_bytes(
            _accessor(sftp), PathSpec.from_str_path("/a.txt"), b"hello"
        )
    assert list(sftp.files.values()) == [b"hello"]
    assert manager.settled == [Settled("/a.txt", b"hello", None, 5)]
    assert manager.writes == []

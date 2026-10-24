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

from collections.abc import AsyncIterator, Callable

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdrive import GoogleDriveVFS
from tests.fixtures.gdrive_api import StubDrive, install_drive
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GoogleDriveVFS, name)


read = _op("read")


def _downloads(
    data: bytes, calls: list[str]
) -> Callable[[str], AsyncIterator[bytes]]:
    """A stream download answering ``data``, each file id it is asked for
    kept in ``calls``."""

    def download(file_id: str) -> AsyncIterator[bytes]:
        calls.append(file_id)
        return _yielded(data)

    return download


async def _yielded(data: bytes) -> AsyncIterator[bytes]:
    yield data


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_read_downloads_plain_file(accessor, monkeypatch):
    row = FileStat(
        name="readme.txt",
        type=FileType.FILE,
        modified="2026-04-01T00:00:00Z",
        extra={"file_id": "file123", "resource_type": "gdrive/file"},
    )
    calls: list[str] = []
    install_drive(
        monkeypatch,
        StubDrive(download_file_stream=_downloads(b"file content", calls)),
    )
    result = await read(accessor, _scope("/docs/readme.txt"), entry=row)
    assert calls == ["file123"]
    assert result == b"file content"


@pytest.mark.asyncio
async def test_read_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _scope("/nonexistent.txt"))

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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.gdocs.unlink import unlink
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key

MIME = "application/vnd.google-apps.document"


def _accessor(google_account) -> GDocsAccessor:
    manager = google_account.token_manager()
    return GDocsAccessor(config=manager.config, token_manager=manager)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/gdocs"),
        virtual=virtual,
        directory=virtual,
    )


@pytest.mark.asyncio
async def test_unlink_calls_delete_with_doc_id(google_account):
    made = await google_account.create("Foo", MIME)
    await google_account.run.record_requests()
    await unlink(
        _accessor(google_account),
        _spec(f"/gdocs/owned/Foo__{made}.gdoc.json"),
        FileStat(name=f"Foo__{made}.gdoc.json", type=FileType.FILE),
    )
    assert await google_account.log() == [
        ("DELETE /drive/v3/files/:id", f"/drive/v3/files/{made}")
    ]
    assert await google_account.items() == []


@pytest.mark.asyncio
async def test_unlink_virtual_dir_raises(google_account):
    with pytest.raises(IsADirectoryError):
        await unlink(_accessor(google_account), _spec("/gdocs/owned"))


@pytest.mark.asyncio
async def test_unlink_missing_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await unlink(
            _accessor(google_account),
            _spec("/gdocs/owned/Nope__doc9.gdoc.json"),
        )

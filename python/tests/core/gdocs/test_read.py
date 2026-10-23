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

import json
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.gdocs.read import read
from mirage.core.google.client import TokenManager
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs import GDocsVFS
from mirage.vfs.gdocs.config import GDocsConfig
from tests.fixtures.gdocs_api import StubDocs
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import serve
from tests.fixtures.mounted import Mounted


@pytest.fixture
def token_manager():
    config = GDocsConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


@pytest.fixture
def accessor(token_manager):
    return GDocsAccessor(config=None, token_manager=token_manager)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/gdocs"),
        virtual=virtual,
        directory=virtual,
    )


def _item(stamp: str) -> dict[str, object]:
    return {
        "mimeType": "application/vnd.google-apps.document",
        "id": "doc1",
        "name": "My Doc",
        "modifiedTime": stamp,
        "owners": [{"me": True}],
    }


@pytest.mark.asyncio
async def test_read_of_a_listed_file(accessor):
    item = _item("2026-04-01T00:00:00.000Z")
    mounted = Mounted(GDocsVFS, accessor, "/gdocs")
    doc_json = {
        "documentId": "doc1",
        "title": "My Doc",
        "body": {"content": []},
    }
    with (
        serve(
            drive=StubDrive(
                list_all_files=AsyncMock(return_value=([item], True)),
                get_file=AsyncMock(return_value=item),
            ),
            docs=StubDocs(
                read_doc=AsyncMock(return_value=json.dumps(doc_json).encode())
            ),
        ),
    ):
        (target,) = await mounted.readdir(_spec("/gdocs/owned"))
        parsed = json.loads(await mounted.read(_spec(target)))
    assert parsed["documentId"] == "doc1"


@pytest.mark.asyncio
async def test_a_read_no_listing_named_resolves_by_id(accessor):
    files = [
        {
            "mimeType": "application/vnd.google-apps.document",
            "id": "doc1",
            "name": "Notes",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]
    with (
        serve(
            drive=StubDrive(get_file=AsyncMock(return_value=files[0])),
            docs=StubDocs(
                read_doc=AsyncMock(return_value=b'{"documentId":"doc1"}')
            ),
        ),
    ):
        path = PathSpec(
            vfs_path=mount_key(
                "/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json", "/gdocs"
            ),
            virtual="/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json",
            directory="/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json",
        )
        result = await read(accessor, path)
        assert b"doc1" in result


@pytest.mark.asyncio
async def test_read_missing_file_raises_by_id(accessor):
    with (
        serve(
            drive=StubDrive(
                get_file=AsyncMock(side_effect=FileNotFoundError("missing"))
            ),
            docs=StubDocs(
                read_doc=AsyncMock(
                    side_effect=AssertionError("should not call read_doc")
                )
            ),
        ),
    ):
        path = PathSpec(
            vfs_path=mount_key(
                "/gdocs/owned/Missing__xyz.gdoc.json", "/gdocs"
            ),
            virtual="/gdocs/owned/Missing__xyz.gdoc.json",
            directory="/gdocs/owned/Missing__xyz.gdoc.json",
        )
        with pytest.raises(FileNotFoundError):
            await read(accessor, path)


@pytest.mark.asyncio
async def test_read_propagates_metadata_failure(accessor):
    with (
        serve(
            drive=StubDrive(
                get_file=AsyncMock(
                    side_effect=RuntimeError("google unavailable")
                )
            ),
            docs=StubDocs(
                read_doc=AsyncMock(
                    side_effect=AssertionError("should not call read_doc")
                )
            ),
        ),
    ):
        path = PathSpec(
            vfs_path=mount_key(
                "/gdocs/owned/Missing__xyz.gdoc.json", "/gdocs"
            ),
            virtual="/gdocs/owned/Missing__xyz.gdoc.json",
            directory="/gdocs/owned/Missing__xyz.gdoc.json",
        )
        with pytest.raises(RuntimeError, match="google unavailable"):
            await read(accessor, path)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stamp", "token"),
    [("2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"), ("", None)],
)
async def test_read_records_the_token_stat_reports(accessor, stamp, token):
    # read: fresh compares this record with stat's fingerprint, so both take
    # the file's modified stamp, and a file without one stamps nothing.
    item = _item(stamp)
    mounted = Mounted(GDocsVFS, accessor, "/gdocs")
    scope = RecordingScope()
    try:
        with (
            serve(
                drive=StubDrive(
                    list_all_files=AsyncMock(return_value=([item], True)),
                    get_file=AsyncMock(return_value=item),
                ),
                docs=StubDocs(
                    read_doc=AsyncMock(return_value=b'{"documentId":"doc1"}')
                ),
            ),
        ):
            (target,) = await mounted.readdir(_spec("/gdocs/owned"))
            data = await read(accessor, _spec(target))
            info = await mounted.stat(_spec(target))
    finally:
        scope.close()

    assert [
        (r.op, r.path, r.source, r.bytes, r.fingerprint) for r in scope.records
    ] == [("read", target, "gdocs", len(data), token)]
    assert info.fingerprint == token

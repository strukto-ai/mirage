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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.commands.builtin.gws.factory import fill_path, run_gws_method
from mirage.commands.builtin.gws.methods import GWS_METHODS
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import materialize

METHODS = {(m.service, m.resource, m.method): m for m in GWS_METHODS}


@pytest.fixture
def accessor():
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    manager = TokenManager(config)
    manager._access_token = "tok"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=manager)


def test_fill_path():
    path, query = fill_path("/files/{fileId}/permissions", {
        "fileId": "f1",
        "pageSize": 5,
    })
    assert path == "/files/f1/permissions"
    assert query == {"pageSize": 5}
    with pytest.raises(ValueError, match="must contain fileId"):
        fill_path("/files/{fileId}", {})


@pytest.mark.asyncio
async def test_documents_get_hits_docs_api(accessor):
    method = METHODS[("docs", "documents", "get")]
    with patch(
            "mirage.commands.builtin.gws.factory.google_get",
            new_callable=AsyncMock,
            return_value={
                "documentId": "d1",
                "title": "T"
            },
    ) as get:
        out, io = await run_gws_method(method,
                                       accessor, [],
                                       params='{"documentId": "d1"}')
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {
        "documentId": "d1",
        "title": "T",
    }
    assert get.await_args.args[1].endswith("/v1/documents/d1")


@pytest.mark.asyncio
async def test_files_list_passes_query(accessor):
    method = METHODS[("drive", "files", "list")]
    with patch(
            "mirage.commands.builtin.gws.factory.google_get",
            new_callable=AsyncMock,
            return_value={"files": []},
    ) as get:
        await run_gws_method(method,
                             accessor, [],
                             params='{"q": "trashed=false", "pageSize": 10}')
    assert get.await_args.kwargs["params"] == {
        "q": "trashed=false",
        "pageSize": "10",
    }


@pytest.mark.asyncio
async def test_files_delete_outputs_nothing(accessor):
    method = METHODS[("drive", "files", "delete")]
    with patch(
            "mirage.commands.builtin.gws.factory.google_delete",
            new_callable=AsyncMock,
    ) as delete:
        out, io = await run_gws_method(method,
                                       accessor, [],
                                       params='{"fileId": "f1"}')
    assert out is None
    assert io.exit_code == 0
    assert "/files/f1" in delete.await_args.args[1]


@pytest.mark.asyncio
async def test_files_create_requires_body(accessor):
    method = METHODS[("drive", "files", "create")]
    with pytest.raises(ValueError, match="--json is required"):
        await run_gws_method(method, accessor, [])


@pytest.mark.asyncio
async def test_permissions_create_posts_body(accessor):
    method = METHODS[("drive", "permissions", "create")]
    with patch(
            "mirage.commands.builtin.gws.factory.google_post",
            new_callable=AsyncMock,
            return_value={"id": "p1"},
    ) as post:
        out, _io = await run_gws_method(
            method,
            accessor, [],
            params='{"fileId": "f1"}',
            json='{"role": "reader", "type": "anyone"}')
    assert await materialize(out) == b'{"id":"p1"}'
    assert post.await_args.args[1].endswith("/files/f1/permissions")
    assert post.await_args.args[2] == {"role": "reader", "type": "anyone"}


@pytest.mark.asyncio
async def test_files_export_returns_raw_bytes(accessor):
    method = METHODS[("drive", "files", "export")]
    with patch(
            "mirage.commands.builtin.gws.factory.google_get_bytes",
            new_callable=AsyncMock,
            return_value=b"%PDF-1.4",
    ) as get_bytes:
        out, _io = await run_gws_method(
            method,
            accessor, [],
            params='{"fileId": "f1", "mimeType": "application/pdf"}')
    assert await materialize(out) == b"%PDF-1.4"
    assert "/files/f1/export?mimeType=application/pdf" in \
        get_bytes.await_args.args[1]

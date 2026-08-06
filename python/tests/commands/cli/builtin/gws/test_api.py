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

from mirage.commands.cli.builtin.gws.api import fill_path, run_gws_method
from mirage.commands.cli.builtin.gws.methods import GWS_METHODS
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import materialize

METHODS = {(m.service, m.resource, m.method): m for m in GWS_METHODS}

CONFIG = GoogleConfig(client_id="cid", refresh_token="rt")


def test_fill_path():
    path, query = fill_path("/files/{fileId}/permissions", {
        "fileId": "f1",
        "pageSize": 5,
    })
    assert path == "/files/f1/permissions"
    assert query == {"pageSize": 5}
    with pytest.raises(UsageError, match="must contain fileId"):
        fill_path("/files/{fileId}", {})


@pytest.mark.asyncio
async def test_documents_get_hits_docs_api():
    method = METHODS[("docs", "documents", "get")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_get",
            new_callable=AsyncMock,
            return_value={
                "documentId": "d1",
                "title": "T"
            },
    ) as get:
        out, io = await run_gws_method(
            method,
            CLIInvocation(CONFIG, flags={"params": '{"documentId": "d1"}'}))
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {
        "documentId": "d1",
        "title": "T",
    }
    assert get.await_args.args[1].endswith("/v1/documents/d1")


@pytest.mark.asyncio
async def test_files_list_follows_next_page_token_by_default():
    method = METHODS[("drive", "files", "list")]
    pages = [
        {
            "files": [{
                "id": "a"
            }],
            "nextPageToken": "t1"
        },
        {
            "files": [{
                "id": "b"
            }],
            "nextPageToken": "t2"
        },
        {
            "files": [{
                "id": "c"
            }]
        },
    ]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_get",
            new_callable=AsyncMock,
            side_effect=pages,
    ) as get:
        out, io = await run_gws_method(method, CLIInvocation(CONFIG))
    assert io.exit_code == 0
    assert get.await_count == 3
    tokens = [c.kwargs["params"].get("pageToken") for c in get.await_args_list]
    assert tokens == [None, "t1", "t2"]
    lines = (await materialize(out)).decode().splitlines()
    assert [json.loads(line)["files"][0]["id"]
            for line in lines] == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_single_page_output_has_no_trailing_newline():
    method = METHODS[("drive", "files", "list")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_get",
            new_callable=AsyncMock,
            return_value={"files": []},
    ):
        out, _io = await run_gws_method(method, CLIInvocation(CONFIG))
    assert await materialize(out) == b'{"files":[]}'


@pytest.mark.asyncio
async def test_page_limit_stops_early():
    method = METHODS[("drive", "files", "list")]
    pages = [
        {
            "files": [],
            "nextPageToken": "t1"
        },
        {
            "files": [],
            "nextPageToken": "t2"
        },
        {
            "files": []
        },
    ]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_get",
            new_callable=AsyncMock,
            side_effect=pages,
    ) as get:
        out, _io = await run_gws_method(
            method, CLIInvocation(CONFIG, flags={"page_limit": "2"}))
    assert get.await_count == 2
    assert len((await materialize(out)).decode().splitlines()) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", ["x", "-1", "1.5", "١٢", "²"])
async def test_rejects_a_non_numeric_page_limit(raw):
    # Non-ASCII digits are rejected too, so the flag accepts exactly what
    # TypeScript's /^\d+$/ accepts.
    method = METHODS[("drive", "files", "list")]
    with pytest.raises(UsageError,
                       match="--page-limit must be a whole number"):
        await run_gws_method(method,
                             CLIInvocation(CONFIG, flags={"page_limit": raw}))


@pytest.mark.asyncio
async def test_files_delete_outputs_nothing():
    method = METHODS[("drive", "files", "delete")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_delete",
            new_callable=AsyncMock,
    ) as delete:
        out, io = await run_gws_method(
            method, CLIInvocation(CONFIG, flags={"params":
                                                 '{"fileId": "f1"}'}))
    assert out is None
    assert io.exit_code == 0
    assert "/files/f1" in delete.await_args.args[1]


@pytest.mark.asyncio
async def test_files_create_requires_body():
    method = METHODS[("drive", "files", "create")]
    with pytest.raises(UsageError, match="--json is required"):
        await run_gws_method(method, CLIInvocation(CONFIG))


@pytest.mark.asyncio
async def test_malformed_json_flag_is_a_usage_error():
    method = METHODS[("drive", "files", "create")]
    with pytest.raises(UsageError, match="--json must be valid JSON"):
        await run_gws_method(
            method, CLIInvocation(CONFIG, flags={"json": "{not json"}))


@pytest.mark.asyncio
async def test_permissions_create_posts_body():
    method = METHODS[("drive", "permissions", "create")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_post",
            new_callable=AsyncMock,
            return_value={"id": "p1"},
    ) as post:
        out, _io = await run_gws_method(
            method,
            CLIInvocation(CONFIG,
                          flags={
                              "params": '{"fileId": "f1"}',
                              "json": '{"role": "reader", "type": "anyone"}'
                          }))
    assert await materialize(out) == b'{"id":"p1"}'
    assert post.await_args.args[1].endswith("/files/f1/permissions")
    assert post.await_args.args[2] == {"role": "reader", "type": "anyone"}


@pytest.mark.asyncio
async def test_files_export_returns_raw_bytes():
    method = METHODS[("drive", "files", "export")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_get_bytes",
            new_callable=AsyncMock,
            return_value=b"%PDF-1.4",
    ) as get_bytes:
        out, _io = await run_gws_method(
            method,
            CLIInvocation(CONFIG,
                          flags={
                              "params":
                              '{"fileId": "f1", "mimeType": "application/pdf"}'
                          }))
    assert await materialize(out) == b"%PDF-1.4"
    assert "/files/f1/export?mimeType=application/pdf" in \
        get_bytes.await_args.args[1]


SCOPED = GoogleConfig(client_id="cid", refresh_token="rt", folder_id="F1")


@pytest.mark.asyncio
async def test_injected_parent_declares_shared_drive_support():
    """An injected parent may name a Shared Drive folder, which Drive
    rejects from a client that has not sent supportsAllDrives."""
    method = METHODS[("drive", "files", "create")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_post",
            new_callable=AsyncMock,
            return_value={"id": "f9"},
    ) as post:
        await run_gws_method(
            method, CLIInvocation(SCOPED, flags={"json": '{"name": "n"}'}))
    assert post.await_args.args[2] == {"name": "n", "parents": ["F1"]}
    assert "supportsAllDrives=true" in post.await_args.args[1]


@pytest.mark.asyncio
async def test_explicit_parents_stay_a_passthrough():
    """A caller who typed their own parents owns the query too, so
    nothing is injected into either half of the request."""
    method = METHODS[("drive", "files", "create")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_post",
            new_callable=AsyncMock,
            return_value={"id": "f9"},
    ) as post:
        await run_gws_method(
            method,
            CLIInvocation(
                SCOPED, flags={"json": '{"name": "n", "parents": ["OTHER"]}'}))
    assert post.await_args.args[2] == {"name": "n", "parents": ["OTHER"]}
    assert "supportsAllDrives" not in post.await_args.args[1]


@pytest.mark.asyncio
async def test_relocation_declares_shared_drive_support():
    """The editor create has already happened by the time the move runs,
    so a move that fails on a Shared Drive scope strands the new file."""
    method = METHODS[("sheets", "spreadsheets", "create")]
    with patch("mirage.commands.cli.builtin.gws.api.google_post",
               new_callable=AsyncMock,
               return_value={"spreadsheetId": "s1"}):
        with patch(
                "mirage.commands.cli.builtin.gws.api.google_patch",
                new_callable=AsyncMock,
                return_value={"id": "s1"},
        ) as patch_call:
            await run_gws_method(
                method,
                CLIInvocation(SCOPED,
                              flags={"json":
                                     '{"properties": {"title": "T"}}'}))
    assert patch_call.await_args.kwargs["params"] == {
        "addParents": "F1",
        "removeParents": "root",
        "supportsAllDrives": "true",
    }


@pytest.mark.asyncio
async def test_unscoped_install_places_nothing():
    method = METHODS[("sheets", "spreadsheets", "create")]
    with patch("mirage.commands.cli.builtin.gws.api.google_post",
               new_callable=AsyncMock,
               return_value={"spreadsheetId": "s1"}):
        with patch("mirage.commands.cli.builtin.gws.api.google_patch",
                   new_callable=AsyncMock) as patch_call:
            await run_gws_method(
                method,
                CLIInvocation(CONFIG,
                              flags={"json":
                                     '{"properties": {"title": "T"}}'}))
    patch_call.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_explicitly_empty_parents_array_is_still_the_callers():
    """`parents: []` states a placement as much as `parents: ["root"]`
    does; reading it as absent would relocate the caller's file."""
    method = METHODS[("drive", "files", "create")]
    with patch(
            "mirage.commands.cli.builtin.gws.api.google_post",
            new_callable=AsyncMock,
            return_value={"id": "f9"},
    ) as post:
        await run_gws_method(
            method,
            CLIInvocation(SCOPED,
                          flags={"json": '{"name": "n", "parents": []}'}))
    assert post.await_args.args[2] == {"name": "n", "parents": []}
    assert "supportsAllDrives" not in post.await_args.args[1]

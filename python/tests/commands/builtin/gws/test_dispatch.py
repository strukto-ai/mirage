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

from unittest.mock import AsyncMock

import pytest

import mirage.commands.builtin.gws.dispatch as dispatch_mod
from mirage.accessor.gdrive import GDriveAccessor
from mirage.commands.builtin.gws.dispatch import gws, normalize_flags
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.io.types import IOResult


@pytest.fixture
def accessor():
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    manager = TokenManager(config)
    manager._access_token = "tok"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=manager)


def test_normalize_flags_maps_official_aliases():
    assert normalize_flags({
        "spreadsheet-id": "s1",
        "range": "A1",
        "document-id": "d1",
    }) == {
        "spreadsheet": "s1",
        "range": "A1",
        "document": "d1",
    }


@pytest.mark.asyncio
async def test_dispatch_routes_api_method(accessor, monkeypatch):
    fake = AsyncMock(return_value=(None, IOResult()))
    monkeypatch.setattr(dispatch_mod, "run_gws_method", fake)
    await gws(accessor, [],
              "docs",
              "documents",
              "get",
              params='{"documentId": "d1"}')
    fake.assert_awaited_once()
    method = fake.await_args.args[0]
    assert method.command_name == "gws-docs-documents-get"
    assert fake.await_args.kwargs["params"] == '{"documentId": "d1"}'


@pytest.mark.asyncio
async def test_dispatch_routes_create_via_table(accessor, monkeypatch):
    fake = AsyncMock(return_value=(None, IOResult()))
    monkeypatch.setattr(dispatch_mod, "run_gws_method", fake)
    await gws(accessor, [],
              "docs",
              "documents",
              "create",
              json='{"title": "T"}')
    method = fake.await_args.args[0]
    assert method.command_name == "gws-docs-documents-create"
    assert method.needs_body is True


@pytest.mark.asyncio
async def test_dispatch_routes_plus_helper_with_aliases(accessor, monkeypatch):
    fake = AsyncMock(return_value=(None, IOResult()))
    monkeypatch.setitem(dispatch_mod._HELPERS, "gws-sheets-read", fake)
    await gws(accessor, [], "sheets", "+read", **{
        "spreadsheet-id": "s1",
        "range": "Sheet1!A1:B2"
    })
    fake.assert_awaited_once()
    assert fake.await_args.kwargs == {
        "spreadsheet": "s1",
        "range": "Sheet1!A1:B2",
    }


@pytest.mark.asyncio
async def test_dispatch_usage_errors(accessor):
    with pytest.raises(ValueError, match="Usage: gws"):
        await gws(accessor, [], "docs")
    with pytest.raises(ValueError, match="missing method"):
        await gws(accessor, [], "docs", "documents")
    with pytest.raises(ValueError, match="unknown method"):
        await gws(accessor, [], "docs", "documents", "destroy")
    with pytest.raises(ValueError, match="unknown command"):
        await gws(accessor, [], "docs", "+nope")

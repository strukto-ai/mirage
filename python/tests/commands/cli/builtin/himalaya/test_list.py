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

import pytest

from mirage.commands.cli.builtin.himalaya import list_envelopes
from mirage.io.types import materialize
from mirage.resource.email.config import EmailConfig

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")


@pytest.fixture
def patched(monkeypatch):
    seen = {}

    async def fake_search(accessor, folder, **criteria):
        seen["folder"] = folder
        seen["criteria"] = criteria
        return seen.get("uids", ["1", "2"])

    async def fake_headers(accessor, folder, uids):
        return [{"uid": uid, "subject": f"s{uid}"} for uid in uids]

    monkeypatch.setitem(list_envelopes.__globals__, "search_messages",
                        fake_search)
    monkeypatch.setitem(list_envelopes.__globals__, "fetch_headers",
                        fake_headers)
    return seen


@pytest.mark.asyncio
async def test_list_defaults_inbox_and_renders_headers(patched):
    out, io = await list_envelopes(CONFIG, [])
    assert io.exit_code == 0
    data = json.loads(await materialize(out))
    assert [d["uid"] for d in data] == ["1", "2"]
    assert patched["folder"] == "INBOX"
    assert patched["criteria"]["max_results"] == 20
    assert patched["criteria"]["unseen"] is False


@pytest.mark.asyncio
async def test_list_threads_search_flags(patched):
    await list_envelopes(
        CONFIG,
        [],
        folder="Archive",
        max=5,
        unseen=True,
        subject="inv",
    )
    assert patched["folder"] == "Archive"
    assert patched["criteria"]["max_results"] == 5
    assert patched["criteria"]["unseen"] is True
    assert patched["criteria"]["subject"] == "inv"


@pytest.mark.asyncio
async def test_list_empty_result_skips_header_fetch(patched, monkeypatch):

    async def fake_search(accessor, folder, **criteria):
        return []

    async def boom(accessor, folder, uids):
        raise AssertionError("fetch_headers must not run for zero uids")

    monkeypatch.setitem(list_envelopes.__globals__, "search_messages",
                        fake_search)
    monkeypatch.setitem(list_envelopes.__globals__, "fetch_headers", boom)
    out, io = await list_envelopes(CONFIG, [])
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == []

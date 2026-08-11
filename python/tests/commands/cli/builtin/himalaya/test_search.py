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

from mirage.commands.cli.builtin.himalaya import search_envelopes
from mirage.commands.cli.builtin.himalaya.query import QueryError
from mirage.commands.cli.types import CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")

HEADERS = {
    "1": {
        "uid": "1",
        "subject": "beta",
        "date": "Mon, 02 Feb 2026 10:00:00 +0000",
    },
    "2": {
        "uid": "2",
        "subject": "alpha",
        "date": "Tue, 03 Feb 2026 10:00:00 +0000",
    },
}


@pytest.fixture
def patched(monkeypatch):
    seen: dict = {}

    async def fake_uids(accessor, folder, criteria, budget=None):
        seen["folder"] = folder
        seen["criteria"] = criteria
        seen["budget"] = budget
        return ["1", "2"]

    async def fake_headers(accessor, folder, uids):
        return [HEADERS[uid] for uid in uids]

    monkeypatch.setitem(search_envelopes.__globals__, "list_message_uids",
                        fake_uids)
    monkeypatch.setitem(search_envelopes.__globals__, "fetch_headers",
                        fake_headers)
    return seen


@pytest.mark.asyncio
async def test_query_tokens_rejoin_before_parsing(patched):
    await search_envelopes(
        CLIInvocation(CONFIG,
                      texts=("from", "alice", "and", "subject", "invoice")))
    assert patched["criteria"] == '(FROM "alice" SUBJECT "invoice")'


@pytest.mark.asyncio
async def test_no_query_searches_everything(patched):
    await search_envelopes(CLIInvocation(CONFIG))
    assert patched["criteria"] == "ALL"


@pytest.mark.asyncio
async def test_sort_clause_orders_the_results_client_side(patched):
    out, io = await search_envelopes(
        CLIInvocation(CONFIG, texts=("order", "by", "subject")))
    assert io.exit_code == 0
    data = json.loads(await materialize(out))
    assert [d["uid"] for d in data] == ["2", "1"]


@pytest.mark.asyncio
async def test_mailbox_and_paging_flags_apply(patched):
    out, _ = await search_envelopes(
        CLIInvocation(CONFIG,
                      flags={
                          "mailbox": "Archive",
                          "page": 2,
                          "page_size": 1
                      }))
    assert patched["folder"] == "Archive"
    data = json.loads(await materialize(out))
    assert [d["uid"] for d in data] == ["1"]


@pytest.mark.asyncio
async def test_a_bad_query_never_reaches_the_server(patched):
    with pytest.raises(QueryError):
        await search_envelopes(CLIInvocation(CONFIG,
                                             texts=("sender", "alice")))
    assert "criteria" not in patched


@pytest.mark.asyncio
async def test_the_default_order_only_fetches_the_pages_asked_for(patched):
    await search_envelopes(
        CLIInvocation(CONFIG,
                      texts=("subject", "alpha"),
                      flags={
                          "page": 2,
                          "page_size": 10
                      }))
    assert patched["budget"] == 20


@pytest.mark.asyncio
async def test_an_explicit_sort_widens_the_fetch_to_the_account_window(
        patched):
    # `order by` is unrelated to arrival order, so the newest N is not
    # enough to know what belongs on page one.
    await search_envelopes(
        CLIInvocation(CONFIG, texts=("order", "by", "subject")))
    assert patched["budget"] == CONFIG.max_messages

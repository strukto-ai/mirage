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
from mirage.commands.cli.types import CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")


def envelope(uid: str, day: int) -> dict:
    return {
        "uid": uid,
        "subject": f"s{uid}",
        "date": f"Mon, {day:02d} Feb 2026 10:00:00 +0000",
    }


@pytest.fixture
def patched(monkeypatch):
    seen: dict = {"uids": ["1", "2", "3"]}

    async def fake_uids(accessor, folder, criteria, budget=None):
        seen["folder"] = folder
        seen["criteria"] = criteria
        seen["budget"] = budget
        # The real client takes the newest `budget` uids, not the oldest.
        return seen["uids"][-budget:] if budget else seen["uids"]

    async def fake_headers(accessor, folder, uids):
        return [envelope(uid, index + 1) for index, uid in enumerate(uids)]

    monkeypatch.setitem(list_envelopes.__globals__, "list_message_uids",
                        fake_uids)
    monkeypatch.setitem(list_envelopes.__globals__, "fetch_headers",
                        fake_headers)
    return seen


@pytest.mark.asyncio
async def test_list_defaults_to_inbox_and_matches_everything(patched):
    out, io = await list_envelopes(CLIInvocation(CONFIG))
    assert io.exit_code == 0
    assert patched["folder"] == "INBOX"
    assert patched["criteria"] == "ALL"
    data = json.loads(await materialize(out))
    # Most recent first, like upstream's `envelope list`.
    assert [d["uid"] for d in data] == ["3", "2", "1"]


@pytest.mark.asyncio
async def test_mailbox_flag_selects_the_folder(patched):
    await list_envelopes(CLIInvocation(CONFIG, flags={"mailbox": "Archive"}))
    assert patched["folder"] == "Archive"


@pytest.mark.asyncio
async def test_pages_count_from_one(patched):
    out, _ = await list_envelopes(
        CLIInvocation(CONFIG, flags={
            "page": 2,
            "page_size": 2
        }))
    data = json.loads(await materialize(out))
    assert [d["uid"] for d in data] == ["1"]


@pytest.mark.asyncio
async def test_empty_result_skips_the_header_fetch(patched, monkeypatch):

    async def boom(accessor, folder, uids):
        raise AssertionError("fetch_headers must not run for zero uids")

    patched["uids"] = []
    monkeypatch.setitem(list_envelopes.__globals__, "fetch_headers", boom)
    out, io = await list_envelopes(CLIInvocation(CONFIG))
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == []


@pytest.mark.asyncio
async def test_only_the_pages_asked_for_are_fetched(patched):
    await list_envelopes(
        CLIInvocation(CONFIG, flags={
            "page": 2,
            "page_size": 2
        }))
    # Not the whole mailbox: one page-worth of headers per page asked for.
    assert patched["budget"] == 4


@pytest.mark.asyncio
async def test_the_account_window_caps_the_fetch(patched):
    await list_envelopes(
        CLIInvocation(CONFIG, flags={
            "page": 100,
            "page_size": 25
        }))
    assert patched["budget"] == CONFIG.max_messages

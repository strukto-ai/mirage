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

from mirage.commands.cli.builtin.himalaya import reply
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")

ORIGINAL = {"subject": "Hi", "uid": "7"}


@pytest.fixture
def patched(monkeypatch):
    calls = {"reply": [], "reply_all": []}

    async def fake_fetch(accessor, folder, uid):
        return ORIGINAL

    async def fake_reply(config, original, body):
        calls["reply"].append((original, body))
        return {"status": "sent", "subject": "Re: Hi"}

    async def fake_reply_all(config, original, body):
        calls["reply_all"].append((original, body))
        return {"status": "sent", "subject": "Re: Hi", "all": True}

    monkeypatch.setitem(reply.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setitem(reply.__globals__, "reply_message", fake_reply)
    monkeypatch.setitem(reply.__globals__, "reply_all_message", fake_reply_all)
    return calls


@pytest.mark.asyncio
async def test_reply_targets_the_sender(patched):
    out, io = await reply(CONFIG, [], uid="7", folder="INBOX", body="ok")
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "subject": "Re: Hi"
    }
    assert patched["reply"] == [(ORIGINAL, "ok")]
    assert patched["reply_all"] == []


@pytest.mark.asyncio
async def test_reply_all_flag_switches_helper(patched):
    out, io = await reply(CONFIG, [],
                          uid="7",
                          folder="INBOX",
                          body="ok",
                          all=True)
    assert io.exit_code == 0
    assert json.loads(await materialize(out))["all"] is True
    assert patched["reply"] == []
    assert patched["reply_all"] == [(ORIGINAL, "ok")]

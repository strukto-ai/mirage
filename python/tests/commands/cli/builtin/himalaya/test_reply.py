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
from email.parser import BytesParser
from email.policy import default as default_policy

import pytest

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya import reply
from mirage.commands.cli.builtin.himalaya import util as util_module
from mirage.commands.cli.types import CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h",
                     smtp_host="h",
                     username="me@example.com",
                     password="p")

ORIGINAL = {
    "subject": "Quarterly numbers",
    "from": {
        "name": "Alice",
        "email": "alice@example.com"
    },
    "cc": [{
        "name": "",
        "email": "bob@example.com"
    }],
    "message_id": "<m1@example.com>",
    "references": [],
    "body_text": "the numbers",
}


@pytest.fixture
def patched(monkeypatch):
    seen: dict = {}

    async def fake_fetch(accessor, folder, uid):
        seen["args"] = (folder, uid)
        return ORIGINAL

    async def fake_send_raw(config, raw):
        seen["raw"] = raw
        return BytesParser(policy=default_policy).parsebytes(raw)

    async def fake_close(self):
        seen["closed"] = True

    monkeypatch.setitem(reply.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setattr(util_module, "send_raw", fake_send_raw)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    return seen


def parse(raw: bytes):
    return BytesParser(policy=default_policy).parsebytes(raw)


@pytest.mark.asyncio
async def test_reply_takes_the_id_positionally_and_defaults_to_inbox(patched):
    await reply(CLIInvocation(CONFIG, texts=("7", ), flags={"body": "thanks"}))
    assert patched["args"] == ("INBOX", "7")
    assert patched["closed"] is True


@pytest.mark.asyncio
async def test_reply_writes_mime_to_stdout_without_send(patched):
    out, io = await reply(
        CLIInvocation(CONFIG, texts=("7", ), flags={"body": "thanks"}))
    assert io.exit_code == 0
    assert "raw" not in patched
    message = parse(await materialize(out))
    assert message["Subject"] == "Re: Quarterly numbers"
    assert message["To"] == "Alice <alice@example.com>"
    assert message["In-Reply-To"] == "<m1@example.com>"
    assert message.get_content() == "thanks\r\n\r\n> the numbers\r\n"


@pytest.mark.asyncio
async def test_reply_all_is_spelled_by_naming_the_other_recipients(patched):
    out, _ = await reply(
        CLIInvocation(CONFIG,
                      texts=("7", ),
                      flags={
                          "body": "thanks",
                          "cc": "bob@example.com"
                      }))
    message = parse(await materialize(out))
    assert message["To"] == "Alice <alice@example.com>"
    assert message["Cc"] == "bob@example.com"


@pytest.mark.asyncio
async def test_bottom_posting_puts_the_quote_first(patched):
    out, _ = await reply(
        CLIInvocation(CONFIG,
                      texts=("7", ),
                      flags={
                          "body": "thanks",
                          "posting_style": "bottom",
                          "quote_headline": "Alice wrote:"
                      }))
    message = parse(await materialize(out))
    assert message.get_content() == (
        "Alice wrote:\r\n> the numbers\r\n\r\nthanks\r\n")


@pytest.mark.asyncio
async def test_send_flag_pushes_through_smtp_and_reports_json(patched):
    out, io = await reply(
        CLIInvocation(CONFIG,
                      texts=("7", ),
                      flags={
                          "body": "thanks",
                          "send": True
                      }))
    assert io.exit_code == 0
    assert b"Re: Quarterly numbers" in patched["raw"]
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "to": "Alice <alice@example.com>",
        "subject": "Re: Quarterly numbers",
    }


@pytest.mark.asyncio
async def test_reply_without_an_id_is_a_usage_error(patched):
    with pytest.raises(ValueError, match="message id is required"):
        await reply(CLIInvocation(CONFIG, flags={"body": "thanks"}))

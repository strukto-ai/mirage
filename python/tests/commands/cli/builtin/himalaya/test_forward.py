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
from mirage.commands.cli.builtin.himalaya import forward
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
    "message_id": "<m1@example.com>",
    "references": ["<m0@example.com>"],
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

    monkeypatch.setitem(forward.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setattr(util_module, "send_raw", fake_send_raw)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    return seen


def parse(raw: bytes):
    return BytesParser(policy=default_policy).parsebytes(raw)


@pytest.mark.asyncio
async def test_forward_quotes_the_source_and_prefixes_fwd(patched):
    out, io = await forward(
        CLIInvocation(CONFIG, texts=("7", ), flags={"to":
                                                    "carol@example.com"}))
    assert io.exit_code == 0
    assert patched["args"] == ("INBOX", "7")
    message = parse(await materialize(out))
    assert message["Subject"] == "Fwd: Quarterly numbers"
    assert message["To"] == "carol@example.com"
    assert message["References"] == "<m0@example.com> <m1@example.com>"
    assert message["In-Reply-To"] is None
    assert message.get_content() == "> the numbers\r\n"


@pytest.mark.asyncio
async def test_forward_carries_the_users_own_note_above_the_quote(patched):
    out, _ = await forward(
        CLIInvocation(CONFIG,
                      texts=("7", ),
                      flags={
                          "to": "carol@example.com",
                          "body": "see below"
                      }))
    message = parse(await materialize(out))
    assert message.get_content() == "see below\r\n\r\n> the numbers\r\n"


@pytest.mark.asyncio
async def test_send_flag_pushes_through_smtp_and_reports_json(patched):
    out, io = await forward(
        CLIInvocation(CONFIG,
                      texts=("7", ),
                      flags={
                          "to": "carol@example.com",
                          "send": True
                      }))
    assert io.exit_code == 0
    assert b"Fwd: Quarterly numbers" in patched["raw"]
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "to": "carol@example.com",
        "subject": "Fwd: Quarterly numbers",
    }


@pytest.mark.asyncio
async def test_forward_needs_a_recipient(patched):
    with pytest.raises(ValueError, match="no recipient"):
        await forward(CLIInvocation(CONFIG, texts=("7", )))


@pytest.mark.asyncio
async def test_forward_without_an_id_is_a_usage_error(patched):
    with pytest.raises(ValueError, match="message id is required"):
        await forward(CLIInvocation(CONFIG, flags={"to": "carol@example.com"}))

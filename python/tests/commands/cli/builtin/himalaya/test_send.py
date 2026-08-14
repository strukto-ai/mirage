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

from mirage.commands.cli.builtin.himalaya import send
from mirage.commands.cli.types import CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")
RAW = b"From: me@example.com\nTo: a@b.com\nSubject: Hi\n\nyo"


@pytest.fixture
def sent(monkeypatch):
    seen: dict = {}

    async def fake_deliver(config, raw, save=None):
        seen["raw"] = raw
        seen["save"] = save
        message = BytesParser(policy=default_policy).parsebytes(raw)
        return message, seen.get("warning", "")

    monkeypatch.setitem(send.__globals__, "deliver", fake_deliver)
    return seen


@pytest.mark.asyncio
async def test_send_reads_the_message_from_stdin(sent):
    out, io = await send(CLIInvocation(CONFIG, stdin=RAW))
    assert io.exit_code == 0
    assert sent["raw"] == RAW
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "to": "a@b.com",
        "subject": "Hi",
    }


@pytest.mark.asyncio
async def test_send_takes_an_inline_message_with_escaped_newlines(sent):
    await send(CLIInvocation(CONFIG,
                             texts=("From:", "me@x", "\\n\\n", "body")))
    assert sent["raw"] == b"From: me@x \n\n body"


@pytest.mark.asyncio
async def test_inline_message_wins_over_stdin(sent):
    await send(CLIInvocation(CONFIG, texts=("From:", "me@x"), stdin=RAW))
    assert sent["raw"] == b"From: me@x"


@pytest.mark.asyncio
async def test_an_empty_message_is_refused_before_smtp(sent):
    with pytest.raises(ValueError, match="no message provided"):
        await send(CLIInvocation(CONFIG, stdin=b"   \n "))
    assert "raw" not in sent


@pytest.mark.asyncio
async def test_a_clean_send_writes_nothing_to_stderr(sent):
    _, io = await send(CLIInvocation(CONFIG, stdin=RAW))
    assert io.stderr is None


@pytest.mark.asyncio
async def test_an_unsaved_copy_reaches_stderr_without_failing_the_verb(sent):
    sent["warning"] = "himalaya: sent copy not saved: Sent: NO\n"
    out, io = await send(CLIInvocation(CONFIG, stdin=RAW))
    assert io.exit_code == 0
    assert await materialize(io.stderr) == sent["warning"].encode()
    assert json.loads(await materialize(out))["status"] == "sent"


@pytest.mark.asyncio
async def test_save_names_the_mailbox_for_the_copy(sent):
    await send(CLIInvocation(CONFIG, stdin=RAW, flags={"save": "Drafts"}))
    assert sent["save"] == "Drafts"


@pytest.mark.asyncio
async def test_without_save_the_account_resolves_its_own_mailbox(sent):
    await send(CLIInvocation(CONFIG, stdin=RAW))
    assert sent["save"] is None

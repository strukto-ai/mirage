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

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya import add, send
from mirage.commands.config import Context
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

EMAIL = EmailAccessor(
    EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")
)
RAW = b"From: me@example.com\nTo: a@b.com\nSubject: Hi\n\nyo"


@pytest.fixture
def sent(monkeypatch):
    seen: dict = {"saved": False}

    async def fake_deliver(accessor, raw, save=None, no_save=False):
        seen["raw"] = raw
        seen["save"] = save
        seen["no_save"] = no_save
        return None, seen["saved"]

    monkeypatch.setitem(
        send.__globals__["finish_message"].__globals__,
        "deliver",
        fake_deliver,
    )
    return seen


@pytest.mark.asyncio
async def test_send_reads_the_message_from_stdin(sent):
    out, io = await send(EMAIL, [], [], Context(stdin=RAW))
    assert io.exit_code == 0
    assert sent["raw"] == RAW
    assert await materialize(out) == b"Message successfully sent\n"


@pytest.mark.asyncio
async def test_json_reports_a_saved_copy(sent):
    sent["saved"] = True
    out, _ = await send(
        EMAIL, [], [], Context(stdin=RAW, flags={"json": True, "save": "Sent"})
    )
    assert json.loads(await materialize(out)) == {
        "message": "Message successfully saved and sent"
    }
    assert sent["save"] == "Sent"


@pytest.mark.asyncio
async def test_an_inline_message_turns_escapes_into_line_breaks(sent):
    await send(
        EMAIL,
        [],
        ["From: a@b\\nTo: c@d\\n\\nbody"],
        Context(argv=("--", "From: a@b\\nTo: c@d\\n\\nbody")),
    )
    assert sent["raw"] == b"From: a@b\r\nTo: c@d\r\n\r\nbody"


@pytest.mark.asyncio
async def test_an_empty_message_is_refused_before_smtp(sent):
    with pytest.raises(ValueError, match="Message is empty"):
        await send(EMAIL, [], [], Context(stdin=b"  \n"))
    assert "raw" not in sent


@pytest.mark.asyncio
async def test_add_reports_the_new_id(monkeypatch):
    seen: dict = {}

    async def fake_append(accessor, raw, folder, flags):
        seen["args"] = (raw, folder, flags)
        return "9"

    monkeypatch.setitem(add.__globals__, "append_message", fake_append)
    out, _ = await add(
        EMAIL,
        [],
        [],
        Context(stdin=RAW, flags={"mailbox": "Archive", "flag": ["flagged"]}),
    )
    assert await materialize(out) == b"Message 9 successfully added"
    assert seen["args"] == (RAW, "Archive", "\\Flagged")

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
from mirage.commands.cli.builtin.himalaya import read
from mirage.commands.cli.types import CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")


@pytest.mark.asyncio
async def test_read_takes_the_id_positionally_and_closes_the_accessor(
        monkeypatch):
    seen = {}
    closed = []

    async def fake_fetch(accessor, folder, uid):
        seen["accessor"] = accessor
        seen["args"] = (folder, uid)
        return {"subject": "Hi", "uid": uid}

    async def fake_close(self):
        closed.append(self)

    monkeypatch.setitem(read.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    out, io = await read(
        CLIInvocation(CONFIG, texts=("7", ), flags={"mailbox": "INBOX"}))
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {"subject": "Hi", "uid": "7"}
    assert isinstance(seen["accessor"], EmailAccessor)
    assert seen["accessor"].config is CONFIG
    assert seen["args"] == ("INBOX", "7")
    assert closed == [seen["accessor"]]


@pytest.mark.asyncio
async def test_read_defaults_the_mailbox_to_inbox(monkeypatch):
    seen = {}

    async def fake_fetch(accessor, folder, uid):
        seen["folder"] = folder
        return {"uid": uid}

    monkeypatch.setitem(read.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setattr(EmailAccessor, "close", lambda self: _noop())
    await read(CLIInvocation(CONFIG, texts=("7", )))
    assert seen["folder"] == "INBOX"


async def _noop():
    return None


@pytest.mark.asyncio
async def test_read_without_an_id_is_a_usage_error():
    with pytest.raises(ValueError, match="message id is required"):
        await read(CLIInvocation(CONFIG))


@pytest.mark.asyncio
async def test_raw_writes_the_rfc5322_bytes_verbatim(monkeypatch):

    async def fake_raw(accessor, folder, uid):
        return b"From: a@x\r\n\r\nbody"

    def boom(*args, **kwargs):
        raise AssertionError("--raw must not parse the message")

    monkeypatch.setitem(read.__globals__, "fetch_raw_message", fake_raw)
    monkeypatch.setitem(read.__globals__, "fetch_message", boom)
    monkeypatch.setattr(EmailAccessor, "close", lambda self: _noop())
    out, io = await read(
        CLIInvocation(CONFIG, texts=("7", ), flags={"raw": True}))
    assert io.exit_code == 0
    assert await materialize(out) == b"From: a@x\r\n\r\nbody"


@pytest.mark.asyncio
async def test_read_closes_the_accessor_on_error(monkeypatch):
    closed = []

    async def fake_fetch(accessor, folder, uid):
        raise FileNotFoundError(uid)

    async def fake_close(self):
        closed.append(self)

    monkeypatch.setitem(read.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    with pytest.raises(FileNotFoundError):
        await read(CLIInvocation(CONFIG, texts=("9", )))
    assert len(closed) == 1

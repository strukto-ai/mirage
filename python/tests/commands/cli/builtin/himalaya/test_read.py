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
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")


@pytest.mark.asyncio
async def test_read_builds_accessor_and_closes_it(monkeypatch):
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
    out, io = await read(CONFIG, [], uid="7", folder="INBOX")
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {"subject": "Hi", "uid": "7"}
    assert isinstance(seen["accessor"], EmailAccessor)
    assert seen["accessor"].config is CONFIG
    assert seen["args"] == ("INBOX", "7")
    assert closed == [seen["accessor"]]


@pytest.mark.asyncio
async def test_read_closes_accessor_on_error(monkeypatch):
    closed = []

    async def fake_fetch(accessor, folder, uid):
        raise FileNotFoundError(uid)

    async def fake_close(self):
        closed.append(self)

    monkeypatch.setitem(read.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    with pytest.raises(FileNotFoundError):
        await read(CONFIG, [], uid="7", folder="INBOX")
    assert len(closed) == 1

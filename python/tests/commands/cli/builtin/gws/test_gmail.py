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

from mirage.commands.cli.builtin.gws.gmail.read import read
from mirage.commands.cli.builtin.gws.gmail.send import send
from mirage.commands.cli.types import CLIInvocation
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import materialize

CONFIG = GoogleConfig(client_id="cid", refresh_token="rt")


@pytest.mark.asyncio
async def test_send_builds_a_token_manager_from_the_config(monkeypatch):
    calls = []

    async def fake_send(tm, to, subject, body):
        calls.append((tm.config, to, subject, body))
        return {"id": "sent1"}

    monkeypatch.setitem(send.__globals__, "send_message", fake_send)
    out, io = await send(
        CLIInvocation(CONFIG,
                      flags={
                          "to": "bob@example.com",
                          "subject": "Hello",
                          "body": "Hi Bob!"
                      }))
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {"id": "sent1"}
    assert calls == [(CONFIG, "bob@example.com", "Hello", "Hi Bob!")]


@pytest.mark.asyncio
async def test_read_fetches_processed_message(monkeypatch):

    async def fake_get(tm, message_id):
        return {"id": message_id, "subject": "S"}

    monkeypatch.setitem(read.__globals__, "get_message_processed", fake_get)
    out, io = await read(CLIInvocation(CONFIG, flags={"id": "m1"}))
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {"id": "m1", "subject": "S"}

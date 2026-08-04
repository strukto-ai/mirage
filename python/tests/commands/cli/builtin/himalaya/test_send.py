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

from mirage.commands.cli.builtin.himalaya import send
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")


@pytest.mark.asyncio
async def test_send_forwards_flags_to_send_message(monkeypatch):
    calls = []

    async def fake_send(config, to, subject, body):
        calls.append((config, to, subject, body))
        return {"status": "sent", "to": to, "subject": subject}

    monkeypatch.setitem(send.__globals__, "send_message", fake_send)
    out, io = await send(CONFIG, [], to="a@b.com", subject="Hi", body="yo")
    assert io.exit_code == 0
    data = json.loads(await materialize(out))
    assert data == {"status": "sent", "to": "a@b.com", "subject": "Hi"}
    assert calls == [(CONFIG, "a@b.com", "Hi", "yo")]

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

from mirage.commands.cli.builtin.himalaya import forward
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")


@pytest.mark.asyncio
async def test_forward_fetches_then_forwards(monkeypatch):
    original = {"subject": "Hi", "uid": "7"}
    calls = []

    async def fake_fetch(accessor, folder, uid):
        return original

    async def fake_forward(config, msg, to):
        calls.append((msg, to))
        return {"status": "sent", "to": to}

    monkeypatch.setitem(forward.__globals__, "fetch_message", fake_fetch)
    monkeypatch.setitem(forward.__globals__, "forward_message", fake_forward)
    out, io = await forward(CONFIG, [],
                            uid="7",
                            folder="Archive",
                            to="x@y.com")
    assert io.exit_code == 0
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "to": "x@y.com"
    }
    assert calls == [(original, "x@y.com")]

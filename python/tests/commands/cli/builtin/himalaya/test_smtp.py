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

import aiosmtplib
import pytest

from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.core.email.config import EmailConfig

RAW = b"From: a@x\r\nTo: b@x\r\nSubject: hi\r\n\r\nthe body\r\n"


@pytest.fixture
def sent(monkeypatch):
    calls: list[dict] = []

    async def fake_send(message, **kwargs):
        calls.append(kwargs)

    monkeypatch.setattr(aiosmtplib, "send", fake_send)
    return calls


def _config(port: int) -> EmailConfig:
    return EmailConfig(
        imap_host="h",
        smtp_host="h",
        smtp_port=port,
        username="u",
        password="p",
    )


@pytest.mark.asyncio
async def test_send_raw_speaks_tls_from_the_first_byte_on_port_465(sent):
    # aiosmtplib connects in plaintext on every port unless use_tls says
    # otherwise, so a port-465 server never answered.
    await send_raw(_config(465), RAW)
    assert sent[-1]["port"] == 465
    assert sent[-1]["use_tls"] is True
    assert sent[-1]["start_tls"] is None


@pytest.mark.parametrize("port", [25, 587, 2525])
@pytest.mark.asyncio
async def test_send_raw_upgrades_with_starttls_elsewhere(sent, port):
    await send_raw(_config(port), RAW)
    assert sent[-1]["port"] == port
    assert sent[-1].get("use_tls", False) is False
    assert sent[-1]["start_tls"] is None

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

from mirage.commands.cli.builtin.himalaya import compose
from mirage.commands.cli.builtin.himalaya import util as util_module
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = EmailConfig(imap_host="h",
                     smtp_host="h",
                     username="me@example.com",
                     password="p")


@pytest.fixture
def sent(monkeypatch):
    seen: dict = {}

    async def fake_send_raw(config, raw):
        seen["raw"] = raw
        return BytesParser(policy=default_policy).parsebytes(raw)

    monkeypatch.setattr(util_module, "send_raw", fake_send_raw)
    return seen


@pytest.mark.asyncio
async def test_compose_writes_mime_to_stdout_without_send(sent):
    out, io = await compose(CONFIG, [], to="a@b.com", subject="Hi", body="yo")
    assert io.exit_code == 0
    assert "raw" not in sent
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message["From"] == "me@example.com"
    assert message["To"] == "a@b.com"
    assert message["Subject"] == "Hi"
    assert message.get_content().strip() == "yo"


@pytest.mark.asyncio
async def test_send_flag_pushes_through_smtp_and_reports_json(sent):
    out, io = await compose(CONFIG, [],
                            to="a@b.com",
                            subject="Hi",
                            body="yo",
                            send=True)
    assert io.exit_code == 0
    assert b"Subject: Hi" in sent["raw"]
    assert json.loads(await materialize(out)) == {
        "status": "sent",
        "to": "a@b.com",
        "subject": "Hi",
    }


@pytest.mark.asyncio
async def test_recipients_accept_repeats_and_comma_lists(sent):
    out, _ = await compose(CONFIG, [],
                           to=["a@x, b@x", "c@x"],
                           cc="d@x",
                           subject="Hi",
                           body="yo")
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message["To"] == "a@x, b@x, c@x"
    assert message["Cc"] == "d@x"


@pytest.mark.asyncio
async def test_body_falls_back_to_stdin(sent):
    out, _ = await compose(CONFIG, [],
                           stdin=b"piped body",
                           to="a@x",
                           subject="Hi")
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message.get_content().strip() == "piped body"


@pytest.mark.asyncio
async def test_from_flag_overrides_the_account_username(sent):
    out, _ = await compose(CONFIG, [], to="a@x", body="yo", **{"from": "x@y"})
    message = BytesParser(policy=default_policy).parsebytes(await
                                                            materialize(out))
    assert message["From"] == "x@y"


@pytest.mark.asyncio
async def test_compose_without_a_recipient_is_refused(sent):
    with pytest.raises(ValueError, match="no recipient"):
        await compose(CONFIG, [], subject="Hi", body="yo")

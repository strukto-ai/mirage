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
from mirage.commands.cli.builtin.himalaya.printer import guarded
from mirage.commands.cli.builtin.himalaya.read import message_view
from mirage.commands.config import Context
from mirage.core.email.config import EmailConfig
from mirage.core.email.mime import parse_mime
from mirage.io.types import materialize

EMAIL = EmailAccessor(
    EmailConfig(imap_host="h", smtp_host="h", username="u", password="p")
)
RAW = (
    b"From: Alice <a@b.c>\r\nTo: d@e.f\r\nSubject: Hi\r\n"
    b"Date: Mon, 05 Jan 2026 09:30:00 +0000\r\n"
    b'Content-Type: multipart/mixed; boundary="b"\r\n\r\n'
    b"--b\r\nContent-Type: text/plain\r\n\r\nthe body\r\n"
    b"--b\r\nContent-Type: text/plain\r\n"
    b'Content-Disposition: attachment; filename="n.txt"\r\n\r\nnote\r\n'
    b"--b--\r\n"
)


@pytest.fixture
def fetched(monkeypatch):
    seen: dict = {"raw": RAW}

    async def fake_fetch(accessor, folder, uid):
        seen["args"] = (folder, uid)
        return seen["raw"]

    async def fake_store(accessor, folder, uids, flags, op):
        seen["stored"] = (folder, uids, flags, op)

    globals_ = read.__globals__
    util = globals_["fetch_source"].__globals__
    monkeypatch.setitem(util, "fetch_raw_message", fake_fetch)
    monkeypatch.setitem(globals_, "store_flags", fake_store)
    return seen


def test_the_view_walks_each_part():
    message = parse_mime(RAW)
    assert message is not None
    assert message_view(message) == (
        "Date: Mon, 5 Jan 2026 09:30:00 +0000\n"
        "From: Alice <a@b.c>\n"
        "To: d@e.f\n"
        "Subject: Hi\n"
        "\n[2] text/plain (8 B)\n    Content-Type: text/plain\n\nthe body\n"
        "\n[3] text/plain — n.txt (4 B)\n    Content-Type: text/plain\n"
        "    Content-Disposition: attachment; filename=n.txt\n\nnote\n"
    )


@pytest.mark.asyncio
async def test_read_defaults_to_text_on_the_inbox(fetched):
    out, io = await read(EMAIL, [], ["7"], Context())
    assert io.exit_code == 0
    assert fetched["args"] == ("INBOX", "7")
    assert (await materialize(out)).startswith(b"Date: Mon, 5 Jan 2026")
    assert "stored" not in fetched


@pytest.mark.asyncio
async def test_json_is_the_parsed_message(fetched):
    out, _ = await read(EMAIL, [], ["7"], Context(flags={"json": True}))
    document = json.loads(await materialize(out))
    assert document["text_body"] == [1]
    assert document["attachments"] == [2]


@pytest.mark.asyncio
async def test_raw_writes_the_bytes_and_json_wraps_them(fetched):
    out, _ = await read(EMAIL, [], ["7"], Context(flags={"raw": True}))
    assert await materialize(out) == RAW
    out, _ = await read(
        EMAIL, [], ["7"], Context(flags={"raw": True, "json": True})
    )
    assert json.loads(await materialize(out)) == {"message": RAW.decode()}


@pytest.mark.asyncio
async def test_seen_marks_the_message(fetched):
    await read(EMAIL, [], ["7"], Context(flags={"seen": True}))
    assert fetched["stored"] == ("INBOX", ["7"], ["\\Seen"], "add")


@pytest.mark.asyncio
async def test_a_failure_is_reported_on_stdout(fetched):
    fetched["raw"] = b""
    out, io = await guarded(read)(EMAIL, [], ["7"], Context())
    assert io.exit_code == 1
    assert (await materialize(out)).startswith(
        b"Error: FETCH returned no body for the requested message\n"
    )

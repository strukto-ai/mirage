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

from mirage.core.email.render import envelope_documents, message_json_bytes

MESSAGE = {
    "from": {"name": "Alice", "email": "alice@example.com"},
    "subject": "Hello",
    "date": "",
    "body_text": "hi there",
    "uid": "101",
    "flags": [],
    "internal_date": "07-Aug-2026 20:54:05 +0000",
}


def test_internaldate_is_not_part_of_the_rendered_message():
    body = json.loads(message_json_bytes(MESSAGE))
    assert "internal_date" not in body
    assert body["uid"] == "101"
    assert body["date"] == ""


def test_rendering_is_stable_whether_or_not_internaldate_is_present():
    # readdir sizes a listed message with this renderer and read() serves
    # it with the same one, so the two must agree byte for byte.
    without = {k: v for k, v in MESSAGE.items() if k != "internal_date"}
    assert message_json_bytes(MESSAGE) == message_json_bytes(without)


FULL = dict(
    MESSAGE,
    body_html="<p>hi there</p>",
    snippet="hi there",
    has_attachments=True,
    attachments=[
        {"filename": "a.txt", "content_type": "text/plain", "size": 3}
    ],
)


def test_an_envelope_carries_no_body():
    # Listing a mailbox fetches every full source, because attachment
    # metadata lives in the MIME structure, but the listing itself is the
    # envelope: 25 HTML bodies do not belong in it (#1067).
    [row] = envelope_documents([FULL])
    assert "body_text" not in row
    assert "body_html" not in row
    assert "snippet" not in row
    assert "internal_date" not in row


def test_an_envelope_keeps_identifiers_headers_and_flags():
    [row] = envelope_documents([FULL])
    assert row["id"] == "101"
    assert row["subject"] == "Hello"
    assert row["from"] == [{"name": "Alice", "email": "alice@example.com"}]
    assert row["flags"] == []
    assert row["has-attachment"] is None


def test_an_envelope_reports_attachments_only_when_asked():
    listing = {"envelopes": envelope_documents([FULL], with_attachment=True)}
    assert listing["envelopes"][0]["has-attachment"] is True


def test_an_envelope_uses_upstreams_field_forms():
    message = dict(
        FULL,
        date="Tue, 06 Jan 2026 08:45:00 +0200",
        message_id="<a@b>",
        in_reply_to="<x@y> <z@w>",
        flags=["\\Flagged", "\\Recent", "custom", "\\Seen"],
        raw_size=42,
    )
    listing = {"envelopes": envelope_documents([message])}
    [row] = listing["envelopes"]
    assert row["message-id"] == "a@b"
    assert row["in-reply-to"] == ["x@y", "z@w"]
    assert row["date"] == "2026-01-06T08:45:00+02:00"
    assert row["size"] == 42
    assert row["flags"] == [
        {"raw": "\\Seen", "iana": "seen"},
        {"raw": "\\Flagged", "iana": "flagged"},
        {"raw": "custom", "iana": None},
    ]


def test_an_unreadable_date_renders_as_null():
    [row] = envelope_documents([dict(FULL, date="soon")])
    assert row["date"] is None


def test_the_document_renderer_still_carries_the_body():
    # The projection is the listing's alone: `cat` of the .email.json and
    # `message read` serve the whole message, and its byte length is what
    # readdir advertised.
    body = json.loads(message_json_bytes(FULL))
    assert body["body_text"] == "hi there"
    assert body["body_html"] == "<p>hi there</p>"
    assert body["snippet"] == "hi there"

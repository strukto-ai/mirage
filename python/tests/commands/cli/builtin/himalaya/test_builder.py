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

import re

import pytest

from mirage.commands.cli.builtin.himalaya.builder import (
    Attachment,
    Compose,
    Source,
    build,
    compose_body,
    has_prefix,
    parse_mailboxes,
    reply_recipients,
)

ORIGINAL = {
    "subject": "Quarterly numbers",
    "from": {"name": "Alice", "email": "alice@example.com"},
    "to": [{"name": "", "email": "me@example.com"}],
    "cc": [{"name": "Bob", "email": "bob@example.com"}],
    "message_id": "<m1@example.com>",
    "references": ["<m0@example.com>"],
    "body_text": "line one\nline two",
}


def stable(raw: bytes) -> str:
    text = raw.decode()
    text = re.sub(r"Message-ID: <[^>]*>\r\n", "", text)
    return re.sub(r"Date: [^\r]*\r\n", "", text)


def test_parse_mailboxes_keeps_display_names_apart():
    assert parse_mailboxes('"Doe, J." <j@x>, b@x') == [
        ("Doe, J.", "j@x"),
        (None, "b@x"),
    ]


def test_parse_mailboxes_refuses_what_has_no_address():
    with pytest.raises(ValueError, match="Could not parse address ``"):
        parse_mailboxes("")


def test_has_prefix_keeps_the_colon():
    assert has_prefix("Re: hello", "Re: ")
    assert has_prefix("re: hello", "Re: ")
    # Without the colon in the comparison this would read as prefixed.
    assert not has_prefix("Ready to ship", "Re: ")


def test_compose_body_lays_out_quote_and_signature():
    assert compose_body("mine\n", "a\n> b\n", "", "", "top") == (
        "mine\n\n> a\n>> b"
    )
    assert compose_body("mine", "a", "On Monday:", "", "bottom") == (
        "On Monday:\n> a\n\nmine"
    )
    assert compose_body("mine", "a", "", "", "none") == "mine"
    assert compose_body("", "a", "", "sig\n", "top") == "> a\n\n-- \nsig"


def test_reply_recipients_prefers_reply_to():
    assert reply_recipients(
        {"reply_to": [{"name": "", "email": "r@x"}], "from": ORIGINAL["from"]}
    ) == [(None, "r@x")]
    assert reply_recipients(ORIGINAL) == [("Alice", "alice@example.com")]


def test_build_lays_headers_out_in_upstreams_order():
    raw = build(
        Compose(
            sender="me@x",
            to=("a@x", "B <b@x>"),
            cc=("c@x",),
            subject="Hi",
            body="hello",
        )
    )
    assert stable(raw) == (
        'From: <me@x>\r\nTo: <a@x>, "B" <b@x>\r\nCc: <c@x>\r\nSubject: Hi\r\n'
        'MIME-Version: 1.0\r\nContent-Type: text/plain; charset="utf-8"\r\n'
        "Content-Transfer-Encoding: 7bit\r\n\r\nhello"
    )


def test_build_writes_an_id_and_a_date():
    text = build(Compose(sender="me@x", body="x")).decode()
    assert re.search(r"Message-ID: <[0-9a-f.]+@localhost>\r\n", text)
    assert re.search(r"Date: \w{3}, \d{1,2} \w{3} \d{4} ", text)


def test_a_trailing_space_line_forces_quoted_printable():
    raw = build(Compose(sender="me@x", body="hello", signature="sig"))
    text = stable(raw)
    assert "Content-Transfer-Encoding: quoted-printable" in text
    assert text.endswith("hello\r\n\r\n--=20\r\nsig")


def test_non_ascii_subject_is_an_encoded_word():
    assert "Subject: =?utf-8?B?UsOpc3Vtw6k=?=\r\n" in stable(
        build(Compose(sender="me@x", subject="Résumé", body="x"))
    )


def test_a_reply_threads_and_quotes():
    raw = build(
        Compose(sender="me@x", body="ack"),
        Source(message=ORIGINAL, mode="reply"),
    )
    text = stable(raw)
    assert 'To: "Alice" <alice@example.com>\r\n' in text
    assert "In-Reply-To: <m1@example.com>\r\n" in text
    assert "References: <m0@example.com> <m1@example.com>\r\n" in text
    assert "Subject: Re: Quarterly numbers\r\n" in text
    assert text.endswith("ack\r\n\r\n> line one\r\n> line two")


def test_a_forward_keeps_references_only():
    text = stable(
        build(
            Compose(sender="me@x", to=("x@y",), body=""),
            Source(message=ORIGINAL, mode="forward"),
        )
    )
    assert "In-Reply-To" not in text
    assert "Subject: Fwd: Quarterly numbers\r\n" in text


def test_attachments_build_multipart_mixed():
    raw = build(
        Compose(
            sender="me@x",
            to=("a@x",),
            body="see",
            attachments=(
                Attachment("note.txt", "text/plain", b"note\n"),
                Attachment("a.bin", "application/octet-stream", b"\x00\xff"),
            ),
        )
    )
    text = stable(raw)
    boundary = re.search(r'boundary="([^"]+)"', text).group(1)
    assert 'Content-Disposition: attachment; filename="note.txt"' in text
    assert "Content-Transfer-Encoding: base64\r\n\r\nAP8=\r\n" in text
    assert text.endswith(f"\r\n--{boundary}--\r\n")


def test_a_decoded_name_cannot_break_a_header_line():
    raw = build(
        Compose(
            sender="me@x", to=("=?UTF-8?B?QQ0KQmNjOiB4QHk=?= <a@b>",), body="x"
        )
    )
    assert b'To: "ABcc: x@y" <a@b>\r\n' in raw

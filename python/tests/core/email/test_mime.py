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

import pytest

from mirage.core.email._parse import parse_rfc822
from mirage.core.email.mime import (
    Stream,
    attribute_of,
    content_type_of,
    header_value,
    parse_mime,
)
from mirage.core.email.render import message_json_bytes
from mirage.core.render.json import compact_json_bytes
from mirage.rs.stream import render_mail
from mirage.types import JsonValue

PLAIN = (
    b"From: Alice <a@b.c>\r\nSubject: =?UTF-8?B?aGk=?=\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n\r\nhello"
)


def test_decodes_an_encoded_subject():
    message = parse_mime(PLAIN)
    assert message is not None
    assert header_value(message.parts[0]["headers"], "subject") == {
        "Text": "hi"
    }
    assert message.parts[0]["body"] == {"Text": "hello"}
    assert message.text_body == [0]


def test_reads_a_content_type_attribute():
    message = parse_mime(PLAIN)
    assert message is not None
    content = content_type_of(message.parts[0]["headers"], "content_type")
    assert content is not None
    assert (content["c_type"], content["c_subtype"]) == ("text", "plain")
    assert attribute_of(content, "charset") == "utf-8"


def test_nothing_parseable_is_none():
    assert parse_mime(b"") is None


def test_an_attached_message_keeps_its_bytes_on_every_path():
    inner = b"Subject: in\r\n\r\nbody"
    multipart = (
        b'Content-Type: multipart/mixed; boundary="b"\r\n\r\n'
        b"--b\r\nContent-Type: message/rfc822\r\n\r\n"
        + inner
        + b"\r\n--b--\r\n"
    )
    encoded = (
        b'Content-Type: multipart/mixed; boundary="b"\r\n\r\n'
        b"--b\r\nContent-Type: message/rfc822\r\n"
        b"Content-Transfer-Encoding: base64\r\n\r\n"
        b"U3ViamVjdDogaW4NCg0KYm9keQ==\r\n--b--\r\n"
    )
    for raw in (multipart, encoded):
        message = parse_mime(raw)
        assert message is not None
        nested = message.parts[message.attachments[0]]["body"]["Message"]
        assert nested.raw == inner


def test_nested_messages_share_the_outer_bytes():
    wrapper = b"Content-Type: message/rfc822\r\n\r\n"
    message = parse_mime(wrapper * 3 + b"Subject: in\r\n\r\nbody")
    assert message is not None
    nested = message.parts[0]["body"]["Message"]
    assert isinstance(nested.raw, memoryview)
    assert nested.raw.obj is not None


SHARED = (
    b"From: Relay <relay@example.test>\r\n"
    b"To: Editor <editor@example.test>\r\n"
    b"Date: Fri, 13 Nov 2026 09:10:11 +0700\r\n"
    b"Received: from relay.example.test (ptr.example.test [192.0.2.1])\r\n"
    b" by mail.example.test with ESMTPS id queue-1 for <editor@example.test>;\r\n"
    b" Fri, 13 Nov 2026 09:10:11 +0700\r\n"
    b"Subject: Quarterly report\r\n"
    b'Content-Type: multipart/mixed; boundary="reports"\r\n\r\n'
    b"--reports\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nReport attached.\r\n"
    b"--reports\r\nContent-Type: application/pdf\r\n"
    b"Content-Disposition: attachment; filename*0*=UTF-8''caf%C3%A9;\r\n"
    b" filename*1=.pdf\r\n"
    b"Content-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n"
    b"--reports--\r\n"
)


def test_shared_mail_renders_structured_trace_and_continued_filename():
    message = parse_mime(SHARED)
    assert message is not None
    assert render_mail(SHARED, {"view": "command_json"}) == compact_json_bytes(
        message.as_document()
    )
    flags: list[JsonValue] = ["\\Seen"]
    expected = parse_rfc822(SHARED)
    expected.update(uid="1", flags=flags)
    assert render_mail(
        SHARED, {"view": "file", "uid": "1", "flags": flags}
    ) == message_json_bytes(expected)
    assert (
        render_mail(SHARED, {"view": "attachment", "filename": "café.pdf"})
        == b"%PDF"
    )


@pytest.mark.parametrize(
    "source",
    [
        SHARED.replace(b"JVBERg==", b"JV!BERg=="),
        SHARED.replace(b"--reports--", b""),
        SHARED.replace(b"filename*1=.pdf", b"filename*2=.pdf"),
        SHARED.replace(
            b"Content-Type: application/pdf", b"Content-Type: message/rfc822"
        ),
        SHARED.replace(b"Quarterly report", b"=?UTF-8?Q?No=C3=ABl?="),
        SHARED.replace(b"Relay <", b"Relay  Name <"),
        SHARED.replace(b"relay@example.test", b"relay@example..test"),
        SHARED.replace(
            b"filename*0*=UTF-8''caf%C3%A9;", b'filename*0=" lead ";'
        ),
    ],
)
def test_shared_mail_delegates_a_message_it_cannot_represent(source):
    assert render_mail(source, {"view": "command_json"}) is None
    assert (
        render_mail(source, {"view": "file", "uid": "1", "flags": []}) is None
    )
    assert (
        render_mail(source, {"view": "attachment", "filename": "café.pdf"})
        is None
    )


def test_transfer_preserves_legacy_recovery_at_multipart_boundary():
    quoted = Stream(b"value \r\n--item--\r\n")
    assert quoted.decode_quoted_printable(b"item") == (6, b"value")
    unpadded = Stream(b"JVBERg\r\n--item--\r\n")
    assert unpadded.decode_base64(b"item") == (6, b"%PD")

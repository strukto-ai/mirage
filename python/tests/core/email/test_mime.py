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

from mirage.core.email.mime import (
    attribute_of,
    content_type_of,
    header_value,
    parse_mime,
)

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

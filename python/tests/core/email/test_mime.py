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

from mirage.core.email.mime import parse_attachments, render_mime
from mirage.rs.errors import StreamRefusal

PLAIN = (
    b"From: Alice <a@b.c>\r\nSubject: =?UTF-8?B?aGk=?=\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n\r\nhello"
)


def test_decodes_an_encoded_subject():
    message = json.loads(render_mime(PLAIN, "json"))
    part = message["parts"][0]
    headers = {header["name"]: header["value"] for header in part["headers"]}
    assert headers["subject"] == {"Text": "hi"}
    assert part["body"] == {"Text": "hello"}
    assert message["text_body"] == [0]


def test_reads_a_content_type_attribute():
    part = json.loads(render_mime(PLAIN, "json"))["parts"][0]
    headers = {header["name"]: header["value"] for header in part["headers"]}
    content = headers["content_type"]["ContentType"]
    assert (content["c_type"], content["c_subtype"]) == ("text", "plain")
    assert content["attributes"] == [{"name": "charset", "value": "utf-8"}]


def test_nothing_parseable_refuses():
    with pytest.raises(
        StreamRefusal, match="Failed to parse RFC 5322 message"
    ):
        render_mime(b"", "json")


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
        (attachment,) = parse_attachments(raw, payloads=True)
        assert attachment.payload == inner


def test_header_names_follow_the_reference_parser():
    raw = (
        b"DKIM-Signature: v=1; d=example.com\r\n"
        b"Authentication-Results: mx.example.com; dkim=pass\r\n"
        b"X-Custom: 1\r\n" + PLAIN
    )
    part = json.loads(render_mime(raw, "json"))["parts"][0]
    names = [header["name"] for header in part["headers"][:3]]
    assert names == [
        "dkim_signature",
        "authentication_results",
        {"other": "X-Custom"},
    ]


def test_an_attachment_reports_the_content_type_the_parser_decoded():
    raw = (
        b'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n'
        b"Content-Type: text/plain\r\n"
        b"Content-Type: application/octet-stream\r\n"
        b"Content-Disposition: attachment; filename=a.bin\r\n\r\n"
        b"xyz\r\n--b--\r\n"
    )
    (attachment,) = parse_attachments(raw, payloads=False)
    assert attachment.mime == "application/octet-stream"

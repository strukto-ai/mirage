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

from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from mirage.core.email._parse import parse_rfc822


def test_parse_simple_text_email():
    raw = (
        b"From: Alice <alice@example.com>\r\n"
        b"To: Bob <bob@example.com>\r\n"
        b"Subject: Hello\r\n"
        b"Date: Mon, 14 Apr 2026 10:30:00 +0000\r\n"
        b"Message-ID: <abc123@example.com>\r\n"
        b"\r\n"
        b"Hello, world!"
    )
    result = parse_rfc822(raw)
    assert result["from"] == {"name": "Alice", "email": "alice@example.com"}
    assert result["to"] == [{"name": "Bob", "email": "bob@example.com"}]
    assert result["subject"] == "Hello"
    assert result["body_text"] == "Hello, world!"
    assert result["message_id"] == "<abc123@example.com>"
    assert result["has_attachments"] is False


def test_parse_multipart_email():
    msg = MIMEMultipart()
    msg["From"] = "Alice <alice@example.com>"
    msg["To"] = "Bob <bob@example.com>"
    msg["Subject"] = "With HTML"
    msg["Message-ID"] = "<def456@example.com>"
    msg.attach(MIMEText("Plain text body", "plain"))
    msg.attach(MIMEText("<p>HTML body</p>", "html"))
    raw = msg.as_bytes()

    result = parse_rfc822(raw)
    assert result["body_text"] == "Plain text body"
    assert result["body_html"] == "<p>HTML body</p>"
    assert result["has_attachments"] is False


def test_parse_headers_only():
    raw = (
        b"From: Alice <alice@example.com>\r\n"
        b"Subject: Test\r\n"
        b"\r\n"
        b"Body text here"
    )
    result = parse_rfc822(raw, headers_only=True)
    assert result["subject"] == "Test"
    assert result["body_text"] == ""


def test_parse_reply_headers():
    raw = (
        b"From: Bob <bob@example.com>\r\n"
        b"To: Alice <alice@example.com>\r\n"
        b"Subject: Re: Hello\r\n"
        b"In-Reply-To: <abc123@example.com>\r\n"
        b"References: <abc123@example.com> <def456@example.com>\r\n"
        b"\r\n"
        b"Thanks!"
    )
    result = parse_rfc822(raw)
    assert result["in_reply_to"] == "<abc123@example.com>"
    assert result["references"] == [
        "<abc123@example.com>",
        "<def456@example.com>",
    ]


def test_parse_address_without_name():
    raw = (
        b"From: alice@example.com\r\n"
        b"To: bob@example.com\r\n"
        b"Subject: Test\r\n"
        b"\r\n"
        b"Body"
    )
    result = parse_rfc822(raw)
    assert result["from"]["email"] == "alice@example.com"
    assert result["from"]["name"] == ""


def test_parse_cc():
    raw = (
        b"From: alice@example.com\r\n"
        b"To: bob@example.com\r\n"
        b"Cc: Charlie <charlie@example.com>, dave@example.com\r\n"
        b"Subject: Test\r\n"
        b"\r\n"
        b"Body"
    )
    result = parse_rfc822(raw)
    assert len(result["cc"]) == 2
    assert result["cc"][0]["email"] == "charlie@example.com"


def test_parse_crlf_body_reads_as_lf():
    raw = (
        b"From: Alice <alice@example.com>\r\n"
        b"Subject: Lines\r\n"
        b"\r\n"
        b"line one\r\nline two\r\n"
    )
    result = parse_rfc822(raw)
    assert result["body_text"] == "line one\nline two\n"
    assert result["snippet"] == "line one\nline two\n"


def test_parse_crlf_parts_read_as_lf():
    raw = (
        b'Content-Type: multipart/alternative; boundary="b"\r\n'
        b"\r\n"
        b"--b\r\n"
        b"Content-Type: text/plain\r\n"
        b"Content-Transfer-Encoding: base64\r\n"
        b"\r\n"
        b"b25lDQp0d28NCg==\r\n"
        b"--b\r\n"
        b"Content-Type: text/html\r\n"
        b"\r\n"
        b"<p>x</p>\r\n<p>y</p>\r\n"
        b"--b--\r\n"
    )
    result = parse_rfc822(raw)
    assert result["body_text"] == "one\ntwo\n"
    assert result["body_html"] == "<p>x</p>\n<p>y</p>"


def test_parse_lone_cr_kept():
    result = parse_rfc822(b"Subject: l\r\n\r\na\rb\n")
    assert result["body_text"] == "a\rb\n"

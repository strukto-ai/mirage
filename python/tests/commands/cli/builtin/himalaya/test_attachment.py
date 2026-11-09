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

from mirage.commands.cli.builtin.himalaya.attachment import (
    attachment_rows,
    part_payload,
)
from mirage.core.email.mime import parse_mime

INNER = b"Subject: inner\r\n\r\ninner body"
RAW = (
    b"Subject: outer\r\n"
    b'Content-Type: multipart/mixed; boundary="b"\r\n\r\n'
    b"--b\r\nContent-Type: text/plain\r\n\r\nthe body\r\n"
    b"--b\r\nContent-Type: application/pdf\r\n"
    b'Content-Disposition: attachment; filename="a.pdf"\r\n'
    b"Content-Transfer-Encoding: base64\r\n\r\nJVBERg==\r\n"
    b"--b\r\nContent-Type: message/rfc822\r\n\r\n" + INNER + b"\r\n"
    b"--b--\r\n"
)


def _rows():
    message = parse_mime(RAW)
    assert message is not None
    return attachment_rows(message)


def test_a_binary_part_decodes():
    row = _rows()[0]
    assert (row.id, row.filename, row.mime) == (
        "3",
        "a.pdf",
        "application/pdf",
    )
    assert row.payload == b"%PDF"
    assert not row.inline


def test_an_attached_message_is_its_own_bytes():
    assert _rows()[1].payload == INNER


def test_an_empty_body_has_no_payload():
    assert part_payload({"Multipart": []}) == b""

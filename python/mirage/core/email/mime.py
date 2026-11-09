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

import base64
import binascii
import codecs
import ipaddress
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

ANONYMOUS_BOUNDARY = b""
MAX_NESTED = 3
HEADER_NAMES = {
    "subject": "subject",
    "from": "from",
    "to": "to",
    "cc": "cc",
    "date": "date",
    "bcc": "bcc",
    "reply-to": "reply_to",
    "sender": "sender",
    "comments": "comments",
    "in-reply-to": "in_reply_to",
    "keywords": "keywords",
    "received": "received",
    "message-id": "message_id",
    "references": "references",
    "return-path": "return_path",
    "mime-version": "mime_version",
    "content-description": "content_description",
    "content-id": "content_id",
    "content-language": "content_language",
    "content-location": "content_location",
    "content-transfer-encoding": "content_transfer_encoding",
    "content-type": "content_type",
    "content-disposition": "content_disposition",
    "resent-to": "resent_to",
    "resent-from": "resent_from",
    "resent-bcc": "resent_bcc",
    "resent-cc": "resent_cc",
    "resent-sender": "resent_sender",
    "resent-date": "resent_date",
    "resent-message-id": "resent_message_id",
    "list-archive": "list_archive",
    "list-help": "list_help",
    "list-id": "list_id",
    "list-owner": "list_owner",
    "list-post": "list_post",
    "list-subscribe": "list_subscribe",
    "list-unsubscribe": "list_unsubscribe",
}
UNSTRUCTURED = frozenset(
    {
        "subject",
        "comments",
        "content_description",
        "content_location",
        "content_transfer_encoding",
    }
)
ADDRESSES = frozenset(
    {
        "from",
        "to",
        "cc",
        "bcc",
        "reply_to",
        "sender",
        "resent_to",
        "resent_from",
        "resent_bcc",
        "resent_cc",
        "resent_sender",
        "list_archive",
        "list_help",
        "list_id",
        "list_owner",
        "list_post",
        "list_subscribe",
        "list_unsubscribe",
    }
)
IDS = frozenset(
    {
        "message_id",
        "references",
        "in_reply_to",
        "return_path",
        "content_id",
        "resent_message_id",
    }
)
MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
OBSOLETE_ZONES = {
    "ut": 0,
    "gmt": 0,
    "est": -5,
    "edt": -4,
    "cst": -6,
    "cdt": -5,
    "mst": -7,
    "mdt": -6,
    "pst": -8,
    "pdt": -7,
}
SPACE = (0x20, 0x09)
WHITESPACE = (0x20, 0x09, 0x0A, 0x0C, 0x0D)
HEX_DIGITS = b"0123456789abcdefABCDEF"
BASE64_VALUE = frozenset(
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
)
DASH = 0x2D
NEWLINE = 0x0A
RETURN = 0x0D
ENCODING_PROBLEM = -1


class Kind(Enum):
    """The MIME shapes the part walk tells apart."""

    MIXED = "mixed"
    ALTERNATIVE = "alternative"
    RELATED = "related"
    DIGEST = "digest"
    PLAIN = "plain"
    HTML = "html"
    TEXT_OTHER = "text-other"
    INLINE = "inline"
    MESSAGE = "message"
    OTHER = "other"


def _text(data: bytes) -> str:
    return data.decode("utf-8", "replace")


def _decode_charset(data: bytes, charset: str | None) -> str:
    """Bytes as text in a declared charset, UTF-8 when it is unknown.

    Args:
        data (bytes): the encoded bytes.
        charset (str | None): the charset the part or word declares.
    """
    if charset:
        try:
            return codecs.lookup(charset).decode(data, "replace")[0]
        except LookupError:
            return _text(data)
    return _text(data)


class Stream:
    """A cursor over raw message bytes.

    Args:
        data (bytes): the message.
    """

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0
        self.mark = 0

    def next(self) -> int | None:
        if self.pos < len(self.data):
            byte = self.data[self.pos]
            self.pos += 1
            return byte
        return None

    def peek(self) -> int | None:
        return self.data[self.pos] if self.pos < len(self.data) else None

    def checkpoint(self) -> None:
        self.mark = self.pos

    def restore(self) -> None:
        self.pos = self.mark

    def peek_char(self, char: int) -> bool:
        return self.peek() == char

    def peek_next_is_space(self) -> bool:
        return self.peek() in SPACE

    def try_next_is_space(self) -> bool:
        if self.peek() in SPACE:
            self.pos += 1
            return True
        return False

    def try_skip(self, word: bytes) -> bool:
        if self.data.startswith(word, self.pos):
            self.pos += len(word)
            return True
        return False

    def bytes_between(self, start: int, end: int) -> bytes:
        return self.data[start:end]

    def skip_crlf(self) -> None:
        while (byte := self.peek()) is not None:
            if byte in (RETURN, 0x20, 0x09):
                self.pos += 1
            elif byte == NEWLINE:
                self.pos += 1
                break
            else:
                break

    def seek_next_part(self, boundary: bytes) -> bool:
        if boundary:
            last = 0
            self.checkpoint()
            while (byte := self.next()) is not None:
                if byte == DASH and last == DASH and self.try_skip(boundary):
                    return True
                last = byte
            self.restore()
        return False

    def seek_next_part_offset(self, boundary: bytes) -> int | None:
        last = NEWLINE
        offset = self.pos
        self.checkpoint()
        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                offset = self.pos - (2 if last == RETURN else 1)
            elif byte == DASH and last == DASH and self.try_skip(boundary):
                return offset
            last = byte
        self.restore()
        return None

    def mime_part(self, boundary: bytes) -> tuple[int, bytes]:
        last = NEWLINE
        before = 0
        start = self.pos
        end = self.pos
        self.checkpoint()
        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                end = self.pos - (2 if last == RETURN else 1)
            elif (
                byte == DASH
                and boundary
                and last == DASH
                and self.try_skip(boundary)
            ):
                if before != NEWLINE:
                    end = self.pos - len(boundary) - 2
                return end, self.data[start:end]
            before = last
            last = byte
        if not boundary:
            return self.pos, self.data[start:]
        self.restore()
        return ENCODING_PROBLEM, self.data[start:]

    def seek_part_end(self, boundary: bytes | None) -> tuple[int, bool]:
        last = NEWLINE
        before = 0
        end = self.pos
        if boundary is None:
            self.pos = len(self.data)
            return self.pos, True
        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                end = self.pos - (2 if last == RETURN else 1)
            elif byte == DASH and last == DASH and self.try_skip(boundary):
                if before != NEWLINE:
                    end = self.pos - len(boundary) - 2
                return end, True
            before = last
            last = byte
        return self.pos, False

    def is_multipart_end(self) -> bool:
        self.checkpoint()
        first = self.next()
        second = self.peek()
        if first == RETURN and second == NEWLINE:
            self.pos += 1
            return False
        if first == DASH and second == DASH:
            self.pos += 1
            return True
        if first == NEWLINE:
            return False
        if first in WHITESPACE:
            self.skip_crlf()
            return False
        self.restore()
        return False

    def decode_base64(self, boundary: bytes) -> tuple[int, bytes]:
        data = bytearray()
        group: list[int] = []
        last = NEWLINE
        before = 0
        end = self.pos
        self.checkpoint()
        while (byte := self.next()) is not None:
            if byte in BASE64_VALUE:
                group.append(byte)
                if len(group) == 4:
                    data += base64.b64decode(bytes(group))
                    group.clear()
            elif byte == 0x3D:
                if len(group) in (1, 2):
                    data += _partial_base64(group, 1)
                    group.clear()
                elif len(group) == 3:
                    data += _partial_base64(group, 2)
                    group.clear()
            elif byte == NEWLINE:
                end = self.pos - (2 if last == RETURN else 1)
            elif byte in (0x20, 0x09, RETURN):
                pass
            elif byte == DASH:
                if last == DASH:
                    if boundary and self.try_skip(boundary):
                        at = (
                            end
                            if before == NEWLINE
                            else self.pos - len(boundary) - 2
                        )
                        return at, bytes(data)
                    self.restore()
                    return ENCODING_PROBLEM, b""
            else:
                self.restore()
                return ENCODING_PROBLEM, b""
            before = last
            last = byte
        if boundary:
            self.restore()
            return ENCODING_PROBLEM, b""
        return self.pos, bytes(data)

    def decode_quoted_printable(self, boundary: bytes) -> tuple[int, bytes]:
        data = bytearray()
        state = 0
        high = 0
        last = 0
        before = 0
        spaces = 0
        end = self.pos
        crlf = b"\n"
        self.checkpoint()
        while (byte := self.next()) is not None:
            if byte == 0x3D:
                if state != 0:
                    self.restore()
                    return ENCODING_PROBLEM, b""
                state = 1
            elif byte == NEWLINE:
                end = self.pos - (2 if last == RETURN else 1)
                if state == 1:
                    state = 0
                else:
                    if spaces > 0:
                        del data[len(data) - spaces :]
                    data += crlf
                spaces = 0
            elif byte == RETURN:
                crlf = b"\r\n"
            elif (
                byte == DASH
                and boundary
                and last == DASH
                and self.try_skip(boundary)
            ):
                if before == NEWLINE:
                    del data[len(data) - (len(crlf) + 1) :]
                else:
                    del data[len(data) - 1 :]
                    end = self.pos - len(boundary) - 2
                return end, bytes(data)
            elif state == 0:
                spaces = spaces + 1 if byte in WHITESPACE else 0
                data.append(byte)
            elif state == 1:
                if byte in HEX_DIGITS:
                    high = byte
                    state = 2
                elif byte not in WHITESPACE:
                    state = 0
                    data += bytes((0x3D, byte))
                    spaces = 0
            else:
                state = 0
                if byte in HEX_DIGITS:
                    data.append(int(bytes((high, byte)), 16))
                    spaces = 0
                else:
                    data += bytes((0x3D, high, byte))
            before = last
            last = byte
        if boundary:
            self.restore()
            return ENCODING_PROBLEM, b""
        return self.pos, bytes(data)

    def decode_rfc2047(self) -> str | None:
        if self.next() != 0x3F:
            return None
        charset_start = self.pos
        charset_end = self.pos
        while True:
            byte = self.next()
            if byte is None or byte == NEWLINE:
                return None
            if byte == 0x3F:
                if charset_end == charset_start:
                    charset_end = self.pos - 1
                if charset_end - charset_start < 2:
                    return None
                break
            if byte == 0x2A and charset_end == charset_start:
                charset_end = self.pos - 1
        method = self.next()
        if method is None or chr(method) not in "qQbB":
            return None
        if self.next() != 0x3F:
            return None
        start = self.pos
        close = self.data.find(b"?=", start)
        if close < 0:
            return None
        body = self.data[start:close]
        if NEWLINE in body:
            return None
        self.pos = close + 2
        charset = _text(self.data[charset_start:charset_end])
        if chr(method) in "bB":
            try:
                decoded = base64.b64decode(
                    body + b"=" * (-len(body) % 4), validate=False
                )
            except binascii.Error:
                return None
        else:
            decoded = _decode_q_word(body)
        return _decode_charset(decoded, charset)

    def parse_raw(self) -> Any:
        start = 0
        end = 0
        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                if not self.try_next_is_space():
                    break
                continue
            if byte in (0x20, 0x09, RETURN):
                continue
            if start == 0:
                start = self.pos
            end = self.pos
        if start > 0:
            return {"Text": _text(self.data[start - 1 : end])}
        return "Empty"

    def parse_unstructured(self) -> Any:
        tokens: list[str] = []
        start = 0
        end = 0
        last_encoded = True

        def flush() -> None:
            nonlocal start, last_encoded
            if start > 0:
                if tokens:
                    tokens.append(" ")
                tokens.append(_text(self.data[start - 1 : end]))
                start = 0
                last_encoded = False

        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                flush()
                if self.try_next_is_space():
                    continue
                if not tokens:
                    return "Empty"
                return {"Text": "".join(tokens)}
            if byte in (0x20, 0x09, RETURN):
                continue
            if byte == 0x3D and self.peek_char(0x3F):
                self.checkpoint()
                token = self.decode_rfc2047()
                if token is not None:
                    flush()
                    if not last_encoded:
                        tokens.append(" ")
                    tokens.append(token)
                    last_encoded = True
                    continue
                self.restore()
            if start == 0:
                start = self.pos
            end = self.pos
        return "Empty"

    def parse_id(self) -> Any:
        start = 0
        end = 0
        loose_start = 0
        loose_end = 0
        inside = False
        ids: list[str] = []
        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                if self.try_next_is_space():
                    continue
                if len(ids) == 1:
                    return {"Text": ids[0]}
                if not ids:
                    if loose_start > 0:
                        return {
                            "Text": _text(
                                self.data[loose_start - 1 : loose_end]
                            )
                        }
                    return "Empty"
                return {"TextList": list(ids)}
            if byte == 0x3C:
                inside = True
                continue
            if byte == 0x3E:
                inside = False
                if start > 0:
                    ids.append(_text(self.data[start - 1 : end]))
                    start = 0
                continue
            if byte in (0x20, 0x09, RETURN):
                continue
            if inside:
                if start == 0:
                    start = self.pos
                end = self.pos
            else:
                if loose_start == 0:
                    loose_start = self.pos
                loose_end = self.pos
        return "Empty"

    def parse_comma_separated(self) -> Any:
        tokens: list[str] = []
        items: list[str] = []
        start = 0
        end = 0
        fresh = True

        def flush(add_space: bool) -> None:
            nonlocal start, fresh
            if start > 0:
                if tokens:
                    tokens.append(" ")
                tokens.append(_text(self.data[start - 1 : end]))
                if add_space:
                    tokens.append(" ")
                start = 0
                fresh = True

        def collect() -> None:
            if tokens:
                items.append("".join(tokens))
                tokens.clear()

        while (byte := self.next()) is not None:
            if byte == NEWLINE:
                flush(False)
                if self.try_next_is_space():
                    continue
                collect()
                if len(items) == 1:
                    return {"Text": items[0]}
                return {"TextList": items} if items else "Empty"
            if byte in SPACE:
                fresh = True
                continue
            if byte == 0x3D and fresh and self.peek_char(0x3F):
                self.checkpoint()
                token = self.decode_rfc2047()
                if token is not None:
                    flush(True)
                    tokens.append(token)
                    continue
                self.restore()
            elif byte == 0x2C:
                flush(False)
                collect()
                continue
            elif byte == RETURN:
                continue
            fresh = False
            if start == 0:
                start = self.pos
            end = self.pos
        return "Empty"

    def parse_date(self) -> Any:
        return _DateParser(self).run()

    def parse_address(self) -> Any:
        return _AddressParser(self).run()

    def parse_content_type(self) -> Any:
        return _ContentTypeParser(self).run()

    def parse_received(self) -> Any:
        return _parse_received_value(self)

    def parse_header_name(self) -> str | dict[str, str] | None:
        start = 0
        end = 0
        name = bytearray()
        while (byte := self.next()) is not None:
            if byte == 0x3A:
                if start != 0:
                    break
            elif byte == NEWLINE:
                return None
            elif byte not in WHITESPACE:
                if start == 0:
                    start = self.pos
                end = self.pos
                name.append(byte)
        if start == 0:
            return None
        known = HEADER_NAMES.get(name.decode("latin-1").lower())
        return (
            known
            if known is not None
            else {"other": _text(self.data[start - 1 : end])}
        )

    def parse_headers(self, headers: list[dict[str, Any]]) -> bool:
        while True:
            while True:
                byte = self.peek()
                if byte == NEWLINE:
                    self.pos += 1
                    return True
                if byte is None:
                    return False
                if byte in WHITESPACE:
                    self.pos += 1
                    continue
                break
            offset_field = self.pos
            name = self.parse_header_name()
            if name is not None:
                offset_start = self.pos
                value = self.parse_value(name)
                headers.append(
                    {
                        "name": name,
                        "value": value,
                        "offset_field": offset_field,
                        "offset_start": offset_start,
                        "offset_end": self.pos,
                    }
                )
            elif self.peek() is None:
                return False

    def parse_value(self, name: str | dict[str, str]) -> Any:
        if not isinstance(name, str):
            return self.parse_raw()
        if name in UNSTRUCTURED:
            return self.parse_unstructured()
        if name in ADDRESSES:
            return self.parse_address()
        if name in ("date", "resent_date"):
            return self.parse_date()
        if name in IDS:
            return self.parse_id()
        if name in ("keywords", "content_language"):
            return self.parse_comma_separated()
        if name == "received":
            return self.parse_received()
        if name in ("content_type", "content_disposition"):
            return self.parse_content_type()
        return self.parse_raw()


def _partial_base64(group: list[int], keep: int) -> bytes:
    filled = bytes(group) + b"A" * (4 - len(group))
    return base64.b64decode(filled)[:keep]


def _decode_q_word(body: bytes) -> bytes:
    out = bytearray()
    index = 0
    while index < len(body):
        byte = body[index]
        if byte == 0x5F:
            out.append(0x20)
        elif (
            byte == 0x3D
            and index + 2 < len(body)
            and body[index + 1] in HEX_DIGITS
            and body[index + 2] in HEX_DIGITS
        ):
            out.append(int(body[index + 1 : index + 3], 16))
            index += 2
        else:
            out.append(byte)
        index += 1
    return bytes(out)


class _DateParser:
    """RFC 5322 dates, read as leniently as the parser real clients use.

    Args:
        stream (Stream): positioned at the header value.
    """

    def __init__(self, stream: Stream) -> None:
        self.stream = stream
        self.reset()

    def reset(self) -> None:
        self.pos = 0
        self.parts = [0] * 7
        self.sizes = [2, 2, 4, 2, 2, 2, 4]
        self.month = ""
        self.month_chars = 0
        self.plus = True
        self.fresh = True
        self.ignore = True

    def zone(self, first: int) -> None:
        name = chr(first).lower()
        stream = self.stream
        while (byte := stream.peek()) is not None and chr(byte).isalpha():
            name += chr(byte).lower()
            stream.pos += 1
        hours = OBSOLETE_ZONES.get(name, 0)
        self.plus = hours >= 0
        self.parts[6] = 100 * abs(hours)
        self.sizes[6] = 0

    def run(self) -> Any:
        stream = self.stream
        comments = 0
        while (byte := stream.next()) is not None:
            advance = False
            if byte == NEWLINE:
                if not stream.try_next_is_space():
                    break
                if not self.fresh and not self.ignore and comments == 0:
                    advance = True
                else:
                    continue
            elif comments > 0:
                if byte == 0x29:
                    comments -= 1
                elif byte == 0x28:
                    comments += 1
                elif byte == 0x5C and stream.peek() == 0x29:
                    stream.pos += 1
                continue
            elif 0x30 <= byte <= 0x39:
                if self.pos < 7 and self.sizes[self.pos] > 0:
                    self.sizes[self.pos] -= 1
                    self.parts[self.pos] += (byte - 0x30) * 10 ** self.sizes[
                        self.pos
                    ]
                    self.ignore = False
                self.fresh = False
            elif (
                byte == 0x3A
                and not self.fresh
                and not self.ignore
                and self.pos in (3, 4)
            ):
                advance = True
            elif byte == 0x2B:
                self.pos = 6
            elif byte == DASH:
                self.plus = False
                self.pos = 6
            elif byte in SPACE and not self.fresh and not self.ignore:
                advance = True
            elif chr(byte).isalpha() and byte < 0x80:
                if self.pos == 1:
                    if 1 <= self.month_chars + 1 <= 3:
                        self.month += chr(byte).lower()
                    self.month_chars += 1
                if self.pos == 6:
                    self.zone(byte)
                    advance = True
                self.fresh = False
            elif byte == 0x28:
                comments += 1
                self.fresh = True
                continue
            elif byte == 0x3B:
                self.reset()
                continue
            if advance:
                if self.pos < 7 and self.sizes[self.pos] > 0:
                    self.parts[self.pos] //= 10 ** self.sizes[self.pos]
                self.pos += 1
                self.fresh = True
        return self.finish()

    def finish(self) -> Any:
        if self.pos < 6:
            return "Empty"
        month = (
            MONTHS.get(self.month, 0)
            if self.month_chars == 3
            else self.parts[1]
        )
        if not 1 <= month <= 12:
            return "Empty"
        year = self.parts[2]
        if 0 <= year <= 49:
            year += 2000
        elif 50 <= year <= 99:
            year += 1900
        return {
            "DateTime": {
                "year": year,
                "month": month,
                "day": self.parts[0],
                "hour": self.parts[3],
                "minute": self.parts[4],
                "second": self.parts[5],
                "tz_before_gmt": not self.plus,
                "tz_hour": (self.parts[6] // 100) % 24,
                "tz_minute": (self.parts[6] % 100) % 60,
            }
        }


NAME, ADDRESS, QUOTE, COMMENT = range(4)


class _AddressParser:
    """Mailbox lists and groups, with their comments and encoded words.

    Args:
        stream (Stream): positioned at the header value.
    """

    def __init__(self, stream: Stream) -> None:
        self.stream = stream
        self.token_start = 0
        self.token_end = 0
        self.is_email = False
        self.token_fresh = True
        self.escaped = False
        self.last_encoded = True
        self.names: list[str] = []
        self.mails: list[str] = []
        self.comments: list[str] = []
        self.state = NAME
        self.stack: list[int] = []
        self.addresses: list[dict[str, Any]] = []
        self.group_name: str | None = None
        self.group_comment: str | None = None
        self.groups: list[dict[str, Any]] = []

    def add_token(self) -> None:
        if self.token_start == 0:
            return
        token = _text(self.stream.data[self.token_start - 1 : self.token_end])
        add_space = False
        if self.state == ADDRESS:
            target = self.mails
        elif self.state == NAME:
            if self.is_email:
                target = self.mails
            else:
                add_space = True
                target = self.names
        elif self.state == QUOTE:
            target = self.names
        else:
            add_space = True
            target = self.comments
        if add_space and target:
            target.append(" ")
        target.append(token)
        self.token_start = 0
        self.is_email = False
        self.token_fresh = True
        self.escaped = False
        self.last_encoded = False

    def add_rfc2047(self, token: str) -> None:
        add_space = not self.last_encoded and self.state != QUOTE
        target = self.comments if self.state == COMMENT else self.names
        if add_space and target:
            target.append(" ")
        target.append(token)
        self.last_encoded = True

    def add_address(self) -> None:
        name = "".join(self.names)
        mail = "".join(self.mails)
        comment = "".join(self.comments)
        has_name, has_mail, has_comment = bool(name), bool(mail), bool(comment)
        self.names.clear()
        self.mails.clear()
        self.comments.clear()
        entry: dict[str, Any]
        if has_mail and has_name and has_comment:
            entry = {"name": f"{name} ({comment})", "address": mail}
        elif has_name and has_mail:
            entry = {"name": name, "address": mail}
        elif has_mail and has_comment:
            entry = {"name": comment, "address": mail}
        elif has_mail:
            entry = {"name": None, "address": mail}
        elif has_name and has_comment:
            if not any(ch.isspace() for ch in name):
                entry = {"name": comment, "address": name}
            else:
                entry = {"name": f"{name} ({comment})", "address": None}
        elif has_name:
            entry = {"name": name, "address": None}
        elif has_comment:
            entry = {"name": comment, "address": None}
        else:
            return
        self.addresses.append(entry)

    def add_group_details(self) -> None:
        if self.names:
            self.group_name = "".join(self.names)
            self.names.clear()
        if self.comments:
            self.group_comment = "".join(self.comments)
            self.comments.clear()
        if self.mails:
            mail = "".join(self.mails)
            self.mails.clear()
            self.group_name = (
                f"{self.group_name} {mail}" if self.group_name else mail
            )

    def add_group(self) -> None:
        name = self.group_name
        comment = self.group_comment
        if name is not None and self.addresses and comment is not None:
            title: str | None = f"{name} ({comment})"
        elif self.addresses and name is not None:
            title = name
        elif self.addresses:
            title = comment
        elif name is not None:
            title = name
            self.groups.append({"name": title, "addresses": []})
            self.group_name = None
            return
        else:
            return
        self.groups.append({"name": title, "addresses": self.addresses})
        self.addresses = []
        self.group_name = None
        self.group_comment = None

    def run(self) -> Any:
        stream = self.stream
        while (byte := stream.next()) is not None:
            if byte == NEWLINE:
                self.add_token()
                if self.state == QUOTE:
                    if stream.peek_next_is_space():
                        continue
                    break
                if stream.try_next_is_space():
                    self.token_fresh = True
                    continue
                break
            if byte == 0x5C and self.state != NAME and not self.escaped:
                if self.token_start > 0:
                    if self.state == QUOTE:
                        self.token_end = stream.pos - 1
                    self.add_token()
                self.escaped = True
                continue
            if byte == 0x2C and self.state == NAME:
                self.add_token()
                self.add_address()
                continue
            if byte == 0x3C and self.state == NAME:
                self.is_email = False
                self.add_token()
                self.stack.append(NAME)
                self.state = ADDRESS
                continue
            if byte == 0x3E and self.state == ADDRESS:
                self.add_token()
                self.state = self.stack.pop()
                continue
            if byte == 0x22 and not self.escaped:
                if self.state == NAME:
                    self.stack.append(NAME)
                    self.state = QUOTE
                    self.add_token()
                    continue
                if self.state == QUOTE:
                    self.add_token()
                    self.state = self.stack.pop()
                    continue
            elif byte == 0x40 and self.state == NAME:
                self.is_email = True
            elif (
                byte == 0x3D
                and self.token_fresh
                and not self.escaped
                and stream.peek_char(0x3F)
            ):
                stream.checkpoint()
                token = stream.decode_rfc2047()
                if token is not None:
                    self.add_token()
                    self.add_rfc2047(token)
                    continue
                stream.restore()
            elif byte in SPACE:
                self.token_fresh = True
                self.escaped = False
                if self.state == QUOTE:
                    if self.token_start == 0:
                        self.token_start = stream.pos
                        self.token_end = self.token_start
                    else:
                        self.token_end = stream.pos
                continue
            elif byte == RETURN:
                continue
            elif byte == 0x28 and self.state != QUOTE and not self.escaped:
                self.stack.append(self.state)
                if self.state != COMMENT:
                    self.add_token()
                    self.state = COMMENT
                    self.last_encoded = False
                    continue
            elif byte == 0x29 and self.state == COMMENT and not self.escaped:
                restored = self.stack.pop()
                if self.state != restored:
                    self.add_token()
                    self.state = restored
                    self.last_encoded = False
                    continue
            elif byte == 0x3A and self.state == NAME and not self.escaped:
                self.add_group()
                self.add_token()
                self.add_group_details()
                continue
            elif byte == 0x3B and self.state == NAME:
                self.add_token()
                self.add_address()
                self.add_group()
                continue
            self.escaped = False
            self.token_fresh = False
            if self.token_start == 0:
                self.token_start = stream.pos
                self.token_end = self.token_start
            else:
                self.token_end = stream.pos
        self.add_address()
        if self.group_name is not None or self.groups:
            self.add_group()
            return {"Address": {"Group": self.groups}}
        if self.addresses:
            return {"Address": {"List": self.addresses}}
        return "Empty"


TYPE, SUBTYPE, ATTR_NAME, VALUE, QUOTED, COMMENTED = range(6)


class _ContentTypeParser:
    """A Content-Type or Content-Disposition with its parameters.

    Args:
        stream (Stream): positioned at the header value.
    """

    def __init__(self, stream: Stream) -> None:
        self.stream = stream
        self.state = TYPE
        self.stack: list[int] = []
        self.c_type: str | None = None
        self.c_subtype: str | None = None
        self.attr_name: str | None = None
        self.attr_charset: str | None = None
        self.attr_position = 0
        self.values: list[str] = []
        self.attributes: list[dict[str, str]] = []
        self.continuations: list[tuple[str, int, str]] = []
        self.token_start = 0
        self.token_end = 0
        self.continuation = False
        self.encoded = False
        self.escaped = False
        self.remove_crlf = False
        self.fresh = True

    def reset(self) -> None:
        self.token_start = 0
        self.fresh = True

    def span(self) -> str:
        return _text(self.stream.data[self.token_start - 1 : self.token_end])

    def add_attribute(self) -> bool:
        if self.token_start == 0:
            return False
        value = self.span().lower()
        if self.state == ATTR_NAME:
            self.attr_name = value
        elif self.state == TYPE:
            self.c_type = value
        else:
            self.c_subtype = value
        self.reset()
        return True

    def add_parameter(self) -> None:
        if self.token_start == 0:
            return
        part = self.span()
        if self.attr_charset is None:
            self.attr_charset = part
        else:
            name = f"{self.attr_name or 'unknown'}-language"
            if all(one["name"] != name for one in self.attributes):
                self.attributes.append({"name": name, "value": part})
            else:
                self.values += ["'", part]
        self.reset()

    def add_partial(self, to_current: bool) -> None:
        if self.token_start == 0:
            return
        quoted = self.state == QUOTED
        stop = self.stream.pos - 1 if quoted and to_current else self.token_end
        self.values.append(
            _text(self.stream.data[self.token_start - 1 : stop])
        )
        if not quoted:
            self.values.append(" ")
        self.reset()

    def add_value(self) -> None:
        if self.attr_name is None:
            return
        has_values = bool(self.values)
        value: str | None = None
        if self.token_start > 0:
            raw = self.stream.data[self.token_start - 1 : self.token_end]
            if self.remove_crlf:
                self.remove_crlf = False
                raw = raw.replace(b"\r", b"").replace(b"\n", b"")
            value = _text(raw)
        elif not has_values:
            return
        if not self.continuation:
            name, self.attr_name = self.attr_name, None
            if has_values:
                if value is not None:
                    self.values.append(value)
                joined = "".join(self.values)
            else:
                joined = value or ""
            self.attributes.append({"name": name, "value": joined})
        else:
            name, self.attr_name = self.attr_name, None
            if value is not None:
                joined = "".join(self.values) + value if has_values else value
            else:
                joined = "".join(self.values)
            if self.encoded:
                decoded = _decode_percent(joined)
                if decoded is not None:
                    joined = _decode_charset(decoded, self.attr_charset)
                self.encoded = False
            if self.attr_position > 0:
                self.continuations.append((name, self.attr_position, joined))
                self.attr_position = 0
            else:
                self.attributes.append({"name": name, "value": joined})
            self.continuation = False
            self.attr_charset = None
        if has_values:
            self.values.clear()
        self.reset()

    def add_position(self) -> bool:
        if self.token_start == 0:
            return False
        try:
            self.attr_position = int(self.span())
        except ValueError:
            self.attr_position = 0
        self.reset()
        return True

    def merge(self) -> None:
        for name, _, value in sorted(self.continuations):
            for attribute in self.attributes:
                if attribute["name"] == name:
                    attribute["value"] = f"{attribute['value']}{value}"
                    break
            else:
                self.attributes.append({"name": name, "value": value})

    def finish(self) -> Any:
        if self.continuations:
            self.merge()
        if self.c_type is None:
            return "Empty"
        return {
            "ContentType": {
                "c_type": self.c_type,
                "c_subtype": self.c_subtype,
                "attributes": self.attributes or None,
            }
        }

    def on_newline(self) -> tuple[bool, Any]:
        stream = self.stream
        next_space = stream.peek_next_is_space()
        if self.state in (TYPE, ATTR_NAME, SUBTYPE):
            self.add_attribute()
        elif self.state == VALUE:
            self.add_value()
        elif self.state == QUOTED:
            if next_space:
                stream.pos += 1
                self.remove_crlf = True
                return False, None
            self.add_value()
        if next_space:
            if self.state == TYPE:
                return False, None
            self.state = ATTR_NAME
            stream.pos += 1
            self.fresh = True
            return False, None
        return True, self.finish()

    def run(self) -> Any:
        stream = self.stream
        while (byte := stream.next()) is not None:
            if byte in SPACE:
                self.fresh = True
                if self.state == QUOTED:
                    if self.token_start == 0:
                        self.token_start = stream.pos
                        self.token_end = self.token_start
                    else:
                        self.token_end = stream.pos
                continue
            if byte == NEWLINE:
                done, value = self.on_newline()
                if done:
                    return value
                continue
            if byte == 0x2F and self.state == TYPE:
                self.add_attribute()
                self.state = SUBTYPE
                continue
            if byte == 0x3B:
                if self.state in (TYPE, SUBTYPE, ATTR_NAME):
                    self.add_attribute()
                    self.state = ATTR_NAME
                    continue
                if self.state == VALUE:
                    if not self.escaped:
                        self.add_value()
                        self.state = ATTR_NAME
                    else:
                        self.escaped = False
                    continue
            elif byte == 0x2A and self.state == ATTR_NAME:
                if not self.continuation:
                    self.continuation = self.add_attribute()
                elif not self.encoded:
                    self.add_position()
                    self.encoded = True
                else:
                    self.reset()
                continue
            elif byte == 0x3D:
                if self.state == ATTR_NAME:
                    if not self.continuation:
                        if not self.add_attribute():
                            continue
                    elif not self.encoded:
                        self.encoded = not self.add_position()
                    else:
                        self.reset()
                    self.state = VALUE
                    continue
                if (
                    self.state in (VALUE, QUOTED)
                    and self.fresh
                    and stream.peek_char(0x3F)
                ):
                    stream.checkpoint()
                    token = stream.decode_rfc2047()
                    if token is not None:
                        self.add_partial(False)
                        self.values.append(token)
                        continue
                    stream.restore()
            elif byte == 0x22:
                if self.state == VALUE:
                    self.fresh = True
                    self.state = QUOTED
                    continue
                if self.state == QUOTED:
                    if not self.escaped:
                        self.add_value()
                        self.state = ATTR_NAME
                        continue
                    self.escaped = False
                else:
                    continue
            elif byte == 0x5C:
                if self.state in (QUOTED, VALUE):
                    if not self.escaped:
                        self.add_partial(True)
                        self.escaped = True
                        continue
                    self.escaped = False
                elif self.state == COMMENTED:
                    self.escaped = not self.escaped
                else:
                    continue
            elif (
                byte == 0x27
                and self.encoded
                and not self.escaped
                and self.state in (VALUE, QUOTED)
            ):
                self.add_parameter()
                continue
            elif byte == 0x28 and self.state != QUOTED:
                if not self.escaped:
                    if self.state in (TYPE, ATTR_NAME, SUBTYPE):
                        self.add_attribute()
                    elif self.state == VALUE:
                        self.add_value()
                    self.stack.append(self.state)
                    self.state = COMMENTED
                else:
                    self.escaped = False
                continue
            elif byte == 0x29 and self.state == COMMENTED:
                if not self.escaped:
                    self.state = self.stack.pop()
                    self.reset()
                else:
                    self.escaped = False
                continue
            elif byte == RETURN:
                continue
            self.escaped = False
            self.fresh = False
            if self.token_start == 0:
                self.token_start = stream.pos
                self.token_end = self.token_start
            else:
                self.token_end = stream.pos
        return "Empty"


def _decode_percent(value: str) -> bytes | None:
    out = bytearray()
    raw = value.encode("latin-1", "replace")
    index = 0
    while index < len(raw):
        byte = raw[index]
        if byte == 0x25:
            pair = raw[index + 1 : index + 3]
            if len(pair) != 2 or any(ch not in HEX_DIGITS for ch in pair):
                return None
            out.append(int(pair, 16))
            index += 3
            continue
        out.append(byte)
        index += 1
    return bytes(out)


RECEIVED_PROTOCOLS = frozenset(
    {
        "SMTP",
        "ESMTP",
        "ESMTPA",
        "ESMTPS",
        "ESMTPSA",
        "LMTP",
        "LMTPA",
        "LMTPS",
        "LMTPSA",
        "MMS",
        "UTF8SMTP",
        "UTF8SMTPA",
        "UTF8SMTPS",
        "UTF8SMTPSA",
        "UTF8LMTP",
        "UTF8LMTPA",
        "UTF8LMTPS",
        "UTF8LMTPSA",
        "HTTP",
        "HTTPS",
        "IMAP",
        "POP3",
    }
)
RECEIVED_WORDS = ("from", "by", "via", "with", "id", "for")


def _is_ip(text: str) -> bool:
    try:
        ipaddress.ip_address(text)
    except ValueError:
        return False
    return True


def _host_of(word: str) -> Any:
    bare = word.strip("[]")
    return {"IpAddr": bare} if _is_ip(bare) else {"Name": word}


def _received_tokens(text: str) -> list[str]:
    """The words of a Received value, comments kept whole.

    Args:
        text (str): the unfolded value, before its date.
    """
    tokens: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if char == "(":
            depth = 0
            start = index
            while index < len(text):
                if text[index] == "(":
                    depth += 1
                elif text[index] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                index += 1
            index += 1
            tokens.append(text[start:index])
            continue
        start = index
        while index < len(text) and not text[index].isspace():
            if text[index] == "(":
                break
            index += 1
        tokens.append(text[start:index])
    return tokens


def _apply_from_comment(received: dict[str, Any], comment: str) -> None:
    inner = comment[1:-1]
    open_at = inner.rfind("[")
    close_at = inner.rfind("]")
    if open_at < 0 or close_at < open_at:
        return
    address = inner[open_at + 1 : close_at].removeprefix("IPv6:")
    if not _is_ip(address):
        return
    received["from_ip"] = address
    name = inner[:open_at].strip()
    if name and not _is_ip(name) and " " not in name:
        received["from_iprev"] = name


def _parse_received_value(stream: Stream) -> Any:
    """The fields of a Received header in its ordinary shape.

    Upstream's tokenizer recognizes a long tail of relay-specific comment
    forms; this reads the clause keywords and the date, which is what every
    conforming relay writes.

    Args:
        stream (Stream): positioned at the header value.
    """
    start = stream.pos
    end = stream.pos
    while (byte := stream.next()) is not None:
        if byte == NEWLINE and not stream.try_next_is_space():
            end = stream.pos
            break
    else:
        end = stream.pos
    text = _text(stream.data[start:end])
    clauses, separator, tail = text.rpartition(";")
    if not separator:
        clauses = text
        tail = ""
    received: dict[str, Any] = {
        "from": None,
        "from_ip": None,
        "from_iprev": None,
        "by": None,
        "for_": None,
        "with": None,
        "tls_version": None,
        "tls_cipher": None,
        "id": None,
        "ident": None,
        "helo": None,
        "helo_cmd": None,
        "via": None,
        "date": None,
    }
    words = _received_tokens(clauses)
    index = 0
    while index < len(words):
        word = words[index].lower()
        value = words[index + 1] if index + 1 < len(words) else None
        if word in RECEIVED_WORDS and value is not None:
            if word == "from" and received["from"] is None:
                received["from"] = _host_of(value)
                following = words[index + 2] if index + 2 < len(words) else ""
                if following.startswith("("):
                    _apply_from_comment(received, following)
            elif word == "by" and received["by"] is None:
                received["by"] = _host_of(value)
            elif word == "with" and received["with"] is None:
                protocol = value.rstrip(";").upper()
                if protocol in RECEIVED_PROTOCOLS:
                    received["with"] = protocol
            elif word == "id" and received["id"] is None:
                received["id"] = value.rstrip(";")
            elif word == "for" and received["for_"] is None:
                received["for_"] = value.strip("<>;")
            elif word == "via" and received["via"] is None:
                received["via"] = value
            index += 2
            continue
        index += 1
    if tail.strip():
        parsed = Stream(f"{tail.strip()}\n".encode()).parse_date()
        if isinstance(parsed, dict) and "DateTime" in parsed:
            received["date"] = parsed["DateTime"]
    return {"Received": received}


@dataclass
class WalkState:
    """One level of the part walk."""

    kind: Kind = Kind.MESSAGE
    boundary: bytes | None = None
    in_alternative: bool = False
    parts: int = 0
    html_parts: int = 0
    text_parts: int = 0
    need_html: bool = True
    need_text: bool = True
    part_id: int = 0
    sub_parts: list[int] = field(default_factory=list)
    offset_header: int = 0
    offset_body: int = 0
    offset_end: int = 0


@dataclass
class MimeMessage:
    """A parsed message: its part list and the body indexes into it.

    An attached message also keeps its own bytes in `raw`.
    """

    html_body: list[int] = field(default_factory=list)
    text_body: list[int] = field(default_factory=list)
    attachments: list[int] = field(default_factory=list)
    parts: list[dict[str, Any]] = field(default_factory=list)
    raw: bytes | memoryview = b""

    def is_empty(self) -> bool:
        return not self.parts

    def as_document(self) -> dict[str, Any]:
        return {
            "html_body": self.html_body,
            "text_body": self.text_body,
            "attachments": self.attachments,
            "parts": [_part_document(part) for part in self.parts],
        }


def _part_document(part: dict[str, Any]) -> dict[str, Any]:
    body = part["body"]
    if isinstance(body, dict) and "Message" in body:
        inner: MimeMessage = body["Message"]
        body = {"Message": inner.as_document()}
    return {
        "headers": part["headers"],
        "is_encoding_problem": part["is_encoding_problem"],
        "body": body,
        "offset_header": part["offset_header"],
        "offset_body": part["offset_body"],
        "offset_end": part["offset_end"],
    }


def header_value(headers: list[dict[str, Any]], name: str) -> Any:
    """The value of a part's first header of this name, None when absent.

    Args:
        headers (list[dict[str, Any]]): the part's headers.
        name (str): the header's canonical name.
    """
    for header in headers:
        if header["name"] == name:
            return header["value"]
    return None


def content_type_of(
    headers: list[dict[str, Any]], name: str
) -> dict[str, Any] | None:
    """A Content-Type-shaped header's fields.

    Args:
        headers (list[dict[str, Any]]): the part's headers.
        name (str): ``content_type`` or ``content_disposition``.
    """
    value = header_value(headers, name)
    if isinstance(value, dict) and "ContentType" in value:
        content = value["ContentType"]
        return content if isinstance(content, dict) else None
    return None


def attribute_of(content: dict[str, Any] | None, name: str) -> str | None:
    """A parameter of a Content-Type-shaped value.

    Args:
        content (dict[str, Any] | None): the value's fields.
        name (str): the parameter's name.
    """
    if content is None:
        return None
    for attribute in content.get("attributes") or []:
        if attribute["name"] == name:
            value = attribute["value"]
            return value if isinstance(value, str) else None
    return None


def _mime_kind(
    content: dict[str, Any] | None, parent: Kind
) -> tuple[bool, bool, bool, Kind]:
    if content is None:
        if parent is Kind.DIGEST:
            return False, False, False, Kind.MESSAGE
        return False, True, True, Kind.PLAIN
    c_type = content["c_type"]
    subtype = content["c_subtype"]
    if c_type == "multipart":
        kinds = {
            "mixed": Kind.MIXED,
            "alternative": Kind.ALTERNATIVE,
            "related": Kind.RELATED,
            "digest": Kind.DIGEST,
        }
        return True, False, False, kinds.get(subtype, Kind.OTHER)
    if c_type == "text":
        if subtype == "plain":
            return False, True, True, Kind.PLAIN
        if subtype == "html":
            return False, True, True, Kind.HTML
        return False, False, True, Kind.TEXT_OTHER
    if c_type in ("image", "audio", "video"):
        return False, True, False, Kind.INLINE
    if c_type == "message" and subtype in ("rfc822", "global"):
        return False, False, False, Kind.MESSAGE
    return False, False, False, Kind.OTHER


def parse_mime(raw: bytes, depth: int = MAX_NESTED) -> MimeMessage | None:
    """Parse a message into its part list.

    Part positions are the ids `message read` and `attachment` print, so
    the walk visits a multipart container before its children and counts
    an attached message as a part of its own.

    Args:
        raw (bytes): the RFC 5322 bytes.
        depth (int): how many attached messages deep to keep parsing.
    """
    stream = Stream(raw)
    message = MimeMessage()
    state = WalkState()
    stack: list[tuple[WalkState, MimeMessage | None]] = []
    headers: list[dict[str, Any]] = []
    while True:
        state.offset_header = stream.pos
        if not stream.parse_headers(headers):
            break
        state.offset_body = stream.pos
        state.parts += 1
        state.sub_parts.append(len(message.parts))
        content = content_type_of(headers, "content_type")
        multipart, inline, is_text, kind = _mime_kind(content, state.kind)
        boundary_text = attribute_of(content, "boundary")
        if multipart and boundary_text is not None:
            boundary = boundary_text.encode("utf-8")
            if stream.seek_next_part(boundary):
                next_state = WalkState(
                    in_alternative=state.in_alternative
                    or kind is Kind.ALTERNATIVE,
                    kind=kind,
                    boundary=boundary,
                    html_parts=len(message.html_body),
                    text_parts=len(message.text_body),
                    need_html=state.need_html,
                    need_text=state.need_text,
                    part_id=len(message.parts),
                )
                message.parts.append(
                    {
                        "headers": headers,
                        "is_encoding_problem": False,
                        "body": {"Text": ""},
                        "offset_header": state.offset_header,
                        "offset_body": state.offset_body,
                        "offset_end": 0,
                    }
                )
                headers = []
                stack.append((state, None))
                state = next_state
                stream.skip_crlf()
                continue
            kind = Kind.TEXT_OTHER
            is_text = True
        encoding = header_value(headers, "content_transfer_encoding")
        method = (
            encoding["Text"].lower()
            if isinstance(encoding, dict)
            and isinstance(encoding.get("Text"), str)
            else ""
        )
        boundary_bytes = state.boundary or ANONYMOUS_BOUNDARY
        if kind is Kind.MESSAGE and method not in (
            "base64",
            "quoted-printable",
        ):
            next_state = WalkState(
                kind=Kind.MESSAGE,
                boundary=state.boundary,
                part_id=len(message.parts),
            )
            state.boundary = None
            message.attachments.append(len(message.parts))
            message.parts.append(
                {
                    "headers": headers,
                    "is_encoding_problem": False,
                    "body": {"Text": ""},
                    "offset_header": state.offset_header,
                    "offset_body": state.offset_body,
                    "offset_end": 0,
                }
            )
            headers = []
            stack.append((state, message))
            message = MimeMessage()
            state = next_state
            continue
        if method == "base64":
            offset_end, data = stream.decode_base64(boundary_bytes)
        elif method == "quoted-printable":
            offset_end, data = stream.decode_quoted_printable(boundary_bytes)
        else:
            offset_end, data = stream.mime_part(boundary_bytes)
        problem = offset_end == ENCODING_PROBLEM
        if problem:
            if kind is not Kind.PLAIN:
                kind = Kind.TEXT_OTHER
            inline = False
            is_text = True
            offset_end, found = stream.seek_part_end(state.boundary)
            state.offset_end = offset_end
            data = stream.data[state.offset_body : state.offset_end]
            if not found:
                state.boundary = None
        else:
            state.offset_end = offset_end
        body = _part_body(
            message,
            state,
            headers,
            content,
            kind,
            inline,
            is_text,
            problem,
            data,
            depth,
        )
        problem = problem or body.pop("__problem", False)
        message.parts.append(
            {
                "headers": headers,
                "is_encoding_problem": problem,
                "body": body,
                "offset_header": state.offset_header,
                "offset_body": state.offset_body,
                "offset_end": state.offset_end,
            }
        )
        headers = []
        if state.boundary is not None:
            state, message, done = _close_parts(
                stream, state, stack, message, raw
            )
            if done:
                break
        elif stream.pos >= len(stream.data):
            break
    return _finish(stream, state, stack, message, headers, raw)


def _part_body(
    message: MimeMessage,
    state: WalkState,
    headers: list[dict[str, Any]],
    content: dict[str, Any] | None,
    kind: Kind,
    inline: bool,
    is_text: bool,
    problem: bool,
    data: bytes,
    depth: int,
) -> dict[str, Any]:
    index = len(message.parts)
    if kind is Kind.MESSAGE:
        message.attachments.append(index)
        nested = parse_mime(data, depth - 1) if depth != 0 else None
        if nested is not None:
            nested.raw = data
            return {"Message": nested}
        return {"Binary": list(data), "__problem": True}
    disposition = content_type_of(headers, "content_disposition")
    is_inline = (
        inline
        and not (
            disposition is not None and disposition["c_type"] == "attachment"
        )
        and (
            state.parts == 1
            or (
                state.kind is not Kind.RELATED
                and (
                    kind is Kind.INLINE
                    or content is None
                    or attribute_of(content, "name") is None
                )
            )
        )
    )
    is_inline = is_inline or (
        state.parts == 1
        and state.kind is Kind.MESSAGE
        and kind is Kind.PLAIN
        and problem
    )
    if state.kind is Kind.ALTERNATIVE:
        add_html = kind is Kind.HTML
        add_text = kind is Kind.PLAIN
    elif is_inline:
        if state.in_alternative and (state.need_text or state.need_html):
            if kind is Kind.HTML:
                state.need_text = False
            elif kind is Kind.PLAIN:
                state.need_html = False
        add_html, add_text = state.need_html, state.need_text
    else:
        add_html, add_text = False, False
    if add_html:
        message.html_body.append(index)
    if add_text:
        message.text_body.append(index)
    if is_text:
        text = _decode_charset(data, attribute_of(content, "charset"))
        is_html = kind is Kind.HTML
        if (not add_html and is_html) or (not add_text and not is_html):
            message.attachments.append(index)
        return {"Html": text} if is_html else {"Text": text}
    message.attachments.append(index)
    return {"InlineBinary" if is_inline else "Binary": list(data)}


def _close_parts(
    stream: Stream,
    state: WalkState,
    stack: list[tuple[WalkState, MimeMessage | None]],
    message: MimeMessage,
    raw: bytes,
) -> tuple[WalkState, MimeMessage, bool]:
    while True:
        if state.kind is Kind.MESSAGE:
            previous, parent = stack.pop()
            assert parent is not None
            position = 0
            if state.boundary is not None:
                position = max(stream.pos - len(state.boundary) - 2, 0)
                if position >= 2 and stream.data[position - 2] == RETURN:
                    position -= 2
                else:
                    position -= 1
            else:
                position = stream.pos
            part = parent.parts[state.part_id]
            part["offset_end"] = position
            if message.is_empty():
                part["is_encoding_problem"] = True
                part["body"] = {
                    "Text": _text(raw[part["offset_body"] : position])
                }
            else:
                message.raw = memoryview(raw)[part["offset_body"] : position]
                part["body"] = {"Message": message}
            message = parent
            previous.boundary = state.boundary
            state = previous
        if not stream.is_multipart_end():
            return state, message, False
        if (
            state.kind is Kind.ALTERNATIVE
            and state.need_html
            and state.need_text
        ):
            _share_alternative(message, state)
        part = message.parts[state.part_id]
        if len(state.sub_parts) != 1 or state.sub_parts[0] != 0:
            part["body"] = {"Multipart": state.sub_parts}
        if not stack:
            part["offset_end"] = stream.pos
            return state, message, True
        previous, carried = stack.pop()
        assert carried is None
        state = previous
        if state.boundary is not None:
            offset = stream.seek_next_part_offset(state.boundary)
            if offset is not None:
                part["offset_end"] = offset
                continue
        part["offset_end"] = stream.pos
        return state, message, True


def _share_alternative(message: MimeMessage, state: WalkState) -> None:
    if state.text_parts == len(message.text_body) and state.html_parts != len(
        message.html_body
    ):
        message.text_body.extend(message.html_body[state.html_parts :])
    if state.html_parts == len(message.html_body) and state.text_parts != len(
        message.text_body
    ):
        message.html_body.extend(message.text_body[state.text_parts :])


def _finish(
    stream: Stream,
    state: WalkState,
    stack: list[tuple[WalkState, MimeMessage | None]],
    message: MimeMessage,
    headers: list[dict[str, Any]],
    raw: bytes,
) -> MimeMessage | None:
    while stack:
        previous, parent = stack.pop()
        if parent is not None:
            part = parent.parts[state.part_id]
            part["offset_end"] = stream.pos
            if message.is_empty():
                part["is_encoding_problem"] = True
                part["body"] = {
                    "Text": _text(raw[part["offset_body"] : stream.pos])
                }
            else:
                message.raw = memoryview(raw)[part["offset_body"] : stream.pos]
                part["body"] = {"Message": message}
            message = parent
        else:
            part = message.parts[state.part_id]
            part["offset_end"] = stream.pos
            if len(state.sub_parts) != 1 or state.sub_parts[0] != 0:
                part["body"] = {"Multipart": state.sub_parts}
        state = previous
    if not message.is_empty():
        message.parts[0]["offset_end"] = len(raw)
        return message
    if headers:
        message.parts.append(
            {
                "headers": headers,
                "is_encoding_problem": True,
                "body": {"Text": ""},
                "offset_header": 0,
                "offset_body": len(raw),
                "offset_end": len(raw),
            }
        )
        return message
    return None

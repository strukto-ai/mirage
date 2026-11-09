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
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.mime import Stream
from mirage.io.types import ByteSource, materialize

SourceMode = Literal["reply", "forward"]
PostingStyle = Literal["top", "bottom", "none"]
PREFIXES: dict[SourceMode, str] = {"reply": "Re: ", "forward": "Fwd: "}
FOLD_TARGET = 78
MAX_LINE_LEN = 77
MAX_CONTENT_LEN = 75
MAX_ENCODED_WORD = 75
ENCODED_LINE_TARGET = 76
BASE64_LINE = 76
SIGNATURE_DELIM = "-- \n"
MESSAGE_ID_HOST = "localhost"
INLINE_ESCAPES = frozenset(b"=\r\t\n?")
ATTR_CHARS = frozenset(
    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    b"!#$&+-.^_`|~"
)
Q_PLAIN = frozenset(
    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!*+-/"
)
CRLF = "\r\n"
CONTENT_TYPE_COLUMN = 14


@dataclass(frozen=True, slots=True)
class Attachment:
    """One file attached to an outgoing message.

    Args:
        filename (str): basename presented in Content-Disposition.
        content_type (str): full maintype/subtype pair.
        data (bytes): the file's bytes, read through the workspace.
    """

    filename: str
    content_type: str
    data: bytes


@dataclass(frozen=True, slots=True)
class Compose:
    """The header and body fields the assembler needs.

    Args:
        sender (str): the From address, possibly with a display name.
        to (tuple[str, ...]): To values as typed.
        cc (tuple[str, ...]): Cc values as typed.
        bcc (tuple[str, ...]): Bcc values as typed.
        subject (str | None): explicit subject, None to derive one from
            the source message.
        body (str): the user's own body text.
        signature (str | None): signature appended after its delimiter.
        attachments (tuple[Attachment, ...]): files attached via
            --attach, already read into memory.
    """

    sender: str
    to: tuple[str, ...] = ()
    cc: tuple[str, ...] = ()
    bcc: tuple[str, ...] = ()
    subject: str | None = None
    body: str = ""
    signature: str | None = None
    attachments: tuple[Attachment, ...] = ()


@dataclass(frozen=True, slots=True)
class Source:
    """The message a reply or forward is derived from.

    Args:
        message (dict[str, Any]): the parsed source message.
        mode (SourceMode): whether it is being replied to or forwarded.
        posting_style (PostingStyle): where the quote sits, if anywhere.
        quote_headline (str): literal line placed before the quote.
    """

    message: dict[str, Any]
    mode: SourceMode
    posting_style: PostingStyle = "top"
    quote_headline: str = ""


Mailbox = tuple[str | None, str]


def parse_mailboxes(value: str) -> list[Mailbox]:
    """Split an address value into its mailboxes.

    Args:
        value (str): one flag value, possibly several addresses.

    Raises:
        ValueError: no mailbox parses, or one has no address.
    """
    parsed = Stream(f"{value}\n".encode()).parse_address()
    entries: list[dict[str, Any]] = []
    if isinstance(parsed, dict) and isinstance(parsed.get("Address"), dict):
        address = parsed["Address"]
        if "List" in address:
            entries = address["List"]
        else:
            for group in address["Group"]:
                entries.extend(group["addresses"])
    if not entries:
        raise ValueError(f"Could not parse address `{value}`")
    mailboxes: list[Mailbox] = []
    for entry in entries:
        if entry["address"] is None:
            raise ValueError(f"Address `{value}` has no email")
        mailboxes.append((entry["name"], entry["address"]))
    return mailboxes


def addresses_of(values: tuple[str, ...]) -> list[Mailbox]:
    """Every mailbox a repeated address flag names.

    Args:
        values (tuple[str, ...]): raw flag occurrences.
    """
    out: list[Mailbox] = []
    for value in values:
        out.extend(parse_mailboxes(value))
    return out


def has_prefix(subject: str, prefix: str) -> bool:
    """Whether a subject already carries a Re:/Fwd: prefix.

    The colon is part of the comparison: matching on the letters alone
    would read "Ready to ship" as already prefixed with "Re:".

    Args:
        subject (str): the source subject.
        prefix (str): "Re: " or "Fwd: ".
    """
    head = subject.lstrip()
    marker = prefix.strip()
    return head[: len(marker)].lower() == marker.lower()


def reply_recipients(message: dict[str, Any]) -> list[Mailbox]:
    """Derive a reply's To from the source's Reply-To, else its From.

    Args:
        message (dict[str, Any]): the parsed source message.
    """
    entries = message.get("reply_to") or []
    if not (isinstance(entries, list) and entries):
        sender = message.get("from")
        entries = [sender] if isinstance(sender, dict) else []
    return [
        (str(entry.get("name") or "") or None, str(entry.get("email")))
        for entry in entries
        if entry.get("email")
    ]


def compose_body(
    user_body: str,
    source_text: str,
    headline: str,
    signature: str,
    style: PostingStyle,
) -> str:
    """Lay out the written text, the quoted source and the signature.

    Args:
        user_body (str): the user's own text.
        source_text (str): the source message's text body, or "".
        headline (str): literal line placed before the quote.
        signature (str): signature text, or "".
        style (PostingStyle): where the quote sits, if anywhere.
    """
    written = user_body.rstrip("\n")
    trimmed = source_text.strip()
    quote_lines: list[str] = []
    if trimmed:
        if headline:
            quote_lines.append(headline.rstrip("\n"))
        for line in trimmed.splitlines():
            quote_lines.append(
                f">{line}" if line.startswith(">") else f"> {line}"
            )
    quote = "\n".join(quote_lines)
    if style == "none" or not quote:
        body = written
    elif not written:
        body = quote
    elif style == "bottom":
        body = f"{quote}\n\n{written}"
    else:
        body = f"{written}\n\n{quote}"
    if signature.strip():
        body += f"\n\n{SIGNATURE_DELIM}{signature.rstrip(chr(10))}"
    return body


def _base64_length(size: int) -> int:
    return ((size * 4 // 3) + 3) & ~3


def _inline_encoding(data: bytes) -> str:
    high = any(byte >= 127 for byte in data)
    escapes = sum(1 for byte in data if byte >= 127 or byte in INLINE_ESCAPES)
    needs = high or len(data) > MAX_LINE_LEN
    if data[-1:] in (b" ", b"\t"):
        needs = True
        if data[-1:] == b" ":
            escapes += 1
    if not needs:
        return "none"
    return "q" if len(data) + 2 * escapes < _base64_length(len(data)) else "b"


def _q_word_atoms(text: str, phrase: bool, column: int = 0) -> list[str]:
    charset = "us-ascii" if text.isascii() else "utf-8"
    head = f"=?{charset}?Q?"
    tail = "?="
    limit = min(ENCODED_LINE_TARGET - column, MAX_ENCODED_WORD)
    words: list[str] = []
    current = ""
    for char in text:
        piece = ""
        for byte in char.encode():
            if byte == 0x20:
                piece += "_"
            elif phrase and byte in Q_PLAIN:
                piece += chr(byte)
            elif not phrase and 33 <= byte < 127 and byte not in b"=?_":
                piece += chr(byte)
            else:
                piece += f"={byte:02X}"
        if len(head) + len(current) + len(piece) + len(tail) > limit:
            words.append(f"{head}{current}{tail}")
            current = ""
            limit = MAX_ENCODED_WORD
        current += piece
    words.append(f"{head}{current}{tail}")
    return words


def _b_word_atoms(text: str, column: int = 0) -> list[str]:
    head = "=?utf-8?B?"
    tail = "?="
    budget = min(ENCODED_LINE_TARGET - column, MAX_ENCODED_WORD)
    limit = (budget - len(head) - len(tail)) // 4 * 3
    words: list[str] = []
    current = b""
    for char in text:
        piece = char.encode()
        if len(current) + len(piece) > limit:
            words.append(f"{head}{base64.b64encode(current).decode()}{tail}")
            current = b""
            limit = (MAX_ENCODED_WORD - len(head) - len(tail)) // 4 * 3
        current += piece
    words.append(f"{head}{base64.b64encode(current).decode()}{tail}")
    return words


def _phrase_atoms(name: str) -> list[str]:
    kind = _inline_encoding(name.encode())
    if kind == "b":
        return _b_word_atoms(name)
    if kind == "q":
        return _q_word_atoms(name, True)
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    return [f'"{escaped}"']


def _folded(column: int, atoms: list[str]) -> str:
    out = ""
    for index, atom in enumerate(atoms):
        if index == 0:
            out += atom
            column += len(atom)
        elif column + 1 + len(atom) > FOLD_TARGET and column > 1:
            out += f"{CRLF} {atom}"
            column = 1 + len(atom)
        else:
            out += f" {atom}"
            column += 1 + len(atom)
    return out


def _address_header(name: str, mailboxes: list[Mailbox]) -> str:
    atoms: list[str] = []
    last = len(mailboxes) - 1
    for index, (display, email) in enumerate(mailboxes):
        if display:
            atoms.extend(_phrase_atoms(display))
        atoms.append(f"<{email}>" + ("," if index != last else ""))
    return f"{name}: {_folded(len(name) + 2, atoms)}{CRLF}"


def _unstructured(text: str) -> list[str]:
    """Words of an unstructured value; a line break never survives in one.

    Args:
        text (str): the value.
    """
    words: list[str] = []
    current = ""
    index = 0
    while index < len(text):
        char = text[index]
        if char in "\r\n":
            while index < len(text) and text[index] in " \t\r\n":
                index += 1
            words.append(current)
            current = ""
            continue
        current += char
        index += 1
    words.append(current)
    return " ".join(words).split(" ")


def _text_header(name: str, text: str) -> str:
    column = len(name) + 2
    kind = _inline_encoding(text.encode())
    if kind == "b":
        atoms = _b_word_atoms(text, column)
    elif kind == "q":
        atoms = _q_word_atoms(text, False, column)
    else:
        atoms = _unstructured(text)
    return f"{name}: {_folded(column, atoms)}{CRLF}"


def _body_scan(data: bytes, is_body: bool) -> tuple[str, bool]:
    qp_length = len(data) // 76 + len(data)
    needs = False
    high = False
    bare_feed = False
    line_start = 0
    for at, byte in enumerate(data):
        if byte >= 127:
            high = True
            qp_length += 2
        elif byte == 0x3D or (not is_body and byte == 0x0D):
            qp_length += 2
        elif byte == 0x0A:
            if at + 1 - line_start > MAX_LINE_LEN:
                needs = True
            line_start = at + 1
            after_cr = at > 0 and data[at - 1] == 0x0D
            bare_feed = bare_feed or not after_cr
            if is_body:
                if not after_cr:
                    qp_length += 1
                white = at - 2 if after_cr else at - 1
                if white >= 0 and data[white] in (0x20, 0x09):
                    qp_length += 2
                    needs = True
            else:
                qp_length += 2
                if not after_cr:
                    needs = True
    needs = needs or high
    if data[-1:] in (b" ", b"\t"):
        qp_length += 2
        needs = True
    if len(data) - line_start > MAX_LINE_LEN:
        needs = True
    if not needs:
        return "7bit", bare_feed
    if qp_length < _base64_length(len(data)):
        return "quoted-printable", bare_feed
    return "base64", bare_feed


def _quoted_printable(data: bytes, is_body: bool) -> bytes:
    out = bytearray()
    column = 0

    def plain(chunk: bytes) -> None:
        nonlocal column
        while column + len(chunk) > MAX_CONTENT_LEN:
            room = max(MAX_CONTENT_LEN - column, 0)
            out.extend(chunk[:room])
            out.extend(b"=\r\n")
            column = 0
            chunk = chunk[room:]
        out.extend(chunk)
        column += len(chunk)

    def escape(byte: int) -> None:
        nonlocal column
        if column + 3 > MAX_CONTENT_LEN:
            out.extend(f"=\r\n={byte:02X}".encode())
            column = 3
        else:
            out.extend(f"={byte:02X}".encode())
            column += 3

    def run(chunk: bytes) -> None:
        start = 0
        for index, byte in enumerate(chunk):
            if (is_body and byte in (0x20, 0x09)) or (
                33 <= byte < 127 and byte != 0x3D
            ):
                continue
            if not is_body and byte == 0x20:
                continue
            plain(chunk[start:index])
            escape(byte)
            start = index + 1
        plain(chunk[start:])

    if not is_body:
        trailing = data[-1:] in (b" ", b"\t")
        run(data[:-1] if trailing else data)
        if trailing:
            escape(data[-1])
        return bytes(out)
    lines = data.split(b"\n")
    for index, line in enumerate(lines):
        last = index == len(lines) - 1
        if not last and line.endswith(b"\r"):
            line = line[:-1]
        if line.endswith((b" ", b"\t")):
            run(line[:-1])
            escape(line[-1])
        else:
            run(line)
        if not last:
            out.extend(b"\r\n")
            column = 0
    return bytes(out)


def _base64_wrapped(data: bytes) -> bytes:
    encoded = base64.b64encode(data)
    lines = [
        encoded[at : at + BASE64_LINE]
        for at in range(0, len(encoded), BASE64_LINE)
    ]
    return b"".join(line + b"\r\n" for line in lines)


def _crlf_normalized(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def _encoded_text(data: bytes, is_body: bool) -> bytes:
    encoding, bare_feed = _body_scan(data, is_body)
    head = f"Content-Transfer-Encoding: {encoding}\r\n\r\n".encode()
    if encoding == "base64":
        return head + _base64_wrapped(data)
    if encoding == "quoted-printable":
        return head + _quoted_printable(data, is_body)
    return head + (_crlf_normalized(data) if is_body and bare_feed else data)


def _parameter(key: str, value: str) -> str:
    """A `key=value` header parameter, encoded when it has to be.

    Anything outside printable ASCII is written the RFC 2231 way, which
    leaves no way for a value to end the header line.

    Args:
        key (str): the parameter name.
        value (str): the value.
    """
    data = value.encode()
    if any(not 0x20 <= byte < 0x7F for byte in data):
        encoded = "".join(
            chr(byte) if byte in ATTR_CHARS else f"%{byte:02X}"
            for byte in data
        )
        return f"{key}*=UTF-8''{encoded}"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{key}="{escaped}"'


def _boundary(separator: str) -> str:
    return separator.join(f"{secrets.randbits(64):x}" for _ in range(3))


def _text_part(body: str) -> bytes:
    return b'Content-Type: text/plain; charset="utf-8"\r\n' + _encoded_text(
        body.encode(), True
    )


def _attachment_part(attachment: Attachment) -> bytes:
    maintype = attachment.content_type.split("/", 1)[0]
    parameter = _parameter("filename", attachment.filename)
    head = (
        f"Content-Type: {attachment.content_type}\r\n"
        f"Content-Disposition: attachment; {parameter}\r\n"
    ).encode()
    if maintype == "text":
        return head + _encoded_text(attachment.data, False)
    return (
        head
        + b"Content-Transfer-Encoding: base64\r\n\r\n"
        + _base64_wrapped(attachment.data)
    )


def _body_bytes(body: str, attachments: tuple[Attachment, ...]) -> bytes:
    if not attachments:
        return _text_part(body)
    boundary = _boundary("_")
    parameter = f'boundary="{boundary}"'
    gap = (
        f";{CRLF} "
        if CONTENT_TYPE_COLUMN + 15 + 2 + len(parameter) > FOLD_TARGET
        else "; "
    )
    out = bytearray(
        f"Content-Type: multipart/mixed{gap}{parameter}{CRLF}{CRLF}".encode()
    )
    parts = [_text_part(body), *map(_attachment_part, attachments)]
    for part in parts:
        out += f"\r\n--{boundary}\r\n".encode() + part
    out += f"\r\n--{boundary}--\r\n".encode()
    return bytes(out)


def _rfc822_now() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime(f"%a, {now.day} %b %Y %H:%M:%S +0000")


def _bare_id(message_id: str) -> str:
    return message_id.strip().removeprefix("<").removesuffix(">").strip()


def build(compose: Compose, source: Source | None = None) -> bytes:
    """Assemble an RFC 5322 message from flags and an optional source.

    Args:
        compose (Compose): the header and body fields.
        source (Source | None): the replied-to or forwarded message.
    """
    head: list[str] = []
    name, email = parse_mailboxes(compose.sender)[0]
    head.append(_address_header("From", [(name, email)]))
    if compose.to:
        head.append(_address_header("To", addresses_of(compose.to)))
    if compose.cc:
        head.append(_address_header("Cc", addresses_of(compose.cc)))
    if compose.bcc:
        head.append(_address_header("Bcc", addresses_of(compose.bcc)))
    subject = compose.subject
    source_text = ""
    style: PostingStyle = "top"
    headline = ""
    if source is not None:
        original = source.message
        prefix = PREFIXES[source.mode]
        original_subject = str(original.get("subject", ""))
        if subject is None:
            subject = (
                original_subject
                if has_prefix(original_subject, prefix)
                else f"{prefix}{original_subject}"
            )
        if source.mode == "reply" and not compose.to:
            recipients = reply_recipients(original)
            if recipients:
                head.append(_address_header("To", recipients))
        message_id = str(original.get("message_id", ""))
        if message_id:
            if source.mode == "reply":
                head.append(f"In-Reply-To: <{_bare_id(message_id)}>{CRLF}")
            chain = [*(original.get("references") or []), message_id]
            references = " ".join(
                f"<{_bare_id(one)}>" for one in chain if _bare_id(one)
            )
            head.append(f"References: {references}{CRLF}")
        source_text = str(original.get("body_text", ""))
        style = source.posting_style
        headline = source.quote_headline
    if subject is not None:
        head.append(_text_header("Subject", subject))
    body = compose_body(
        compose.body, source_text, headline, compose.signature or "", style
    )
    head.append(
        f"Message-ID: <{_boundary('.')}@{MESSAGE_ID_HOST}>{CRLF}"
        f"Date: {_rfc822_now()}{CRLF}"
        f"MIME-Version: 1.0{CRLF}"
    )
    return "".join(head).encode() + _body_bytes(body, compose.attachments)


async def read_body(
    fl: FlagView, stdin: ByteSource | None, file_text: str | None
) -> str:
    """Resolve the body from --body, --body-file, then piped stdin.

    Args:
        fl (FlagView): the leaf's parsed flags.
        stdin (ByteSource | None): piped input.
        file_text (str | None): the contents --body-file named.
    """
    inline = fl.as_str("body")
    if inline is not None:
        return inline
    if file_text is not None:
        return file_text
    return (await materialize(stdin)).decode(errors="replace") if stdin else ""

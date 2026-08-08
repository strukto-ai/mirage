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

import hashlib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Literal

from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, materialize

SourceMode = Literal["reply", "forward"]
PostingStyle = Literal["top", "bottom"]
PREFIXES: dict[SourceMode, str] = {"reply": "Re: ", "forward": "Fwd: "}


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
        sender (str): the From address.
        to (tuple[str, ...]): To recipients, already comma-split.
        cc (tuple[str, ...]): Cc recipients.
        bcc (tuple[str, ...]): Bcc recipients.
        subject (str | None): explicit subject, None to derive one from
            the source message.
        body (str): the user's own body text.
        signature (str | None): signature appended after a `-- ` line.
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
        posting_style (PostingStyle): user body above or below the quote.
        quote_headline (str): literal line placed before the quote.
    """
    message: dict[str, Any]
    mode: SourceMode
    posting_style: PostingStyle = "top"
    quote_headline: str = ""


def mixed_boundary(body: str, attachments: tuple[Attachment, ...]) -> str:
    """A deterministic multipart boundary for the message's content.

    EmailMessage would generate a random boundary, which breaks
    byte-for-byte parity with the TypeScript builder and makes the
    no-send stdout non-reproducible. Hashing the content gives a
    boundary that cannot occur inside it (the content would have to
    contain its own hash) while staying stable across runs and
    languages.

    Args:
        body (str): the laid-out text body.
        attachments (tuple[Attachment, ...]): the attached files.
    """
    digest = hashlib.sha256(body.encode())
    for attachment in attachments:
        digest.update(attachment.filename.encode())
        digest.update(attachment.content_type.encode())
        digest.update(attachment.data)
    return digest.hexdigest()[:32]


def split_addresses(values: list[str]) -> tuple[str, ...]:
    """Flatten repeated address flags, splitting comma-separated lists.

    Args:
        values (list[str]): raw flag occurrences.
    """
    out: list[str] = []
    for value in values:
        out.extend(part.strip() for part in value.split(",") if part.strip())
    return tuple(out)


def format_address(entry: dict[str, Any]) -> str:
    """Render one parsed address as a header value.

    Args:
        entry (dict[str, Any]): a parsed address with name and email.
    """
    email = str(entry.get("email", "")).strip()
    name = str(entry.get("name", "") or "").strip()
    return f"{name} <{email}>" if name and email else email


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
    return head[:len(marker)].lower() == marker.lower()


def reply_recipients(message: dict[str, Any]) -> tuple[str, ...]:
    """Derive a reply's To from the source's Reply-To, else its From.

    Args:
        message (dict[str, Any]): the parsed source message.
    """
    reply_to = message.get("reply_to") or []
    if isinstance(reply_to, list) and reply_to:
        return tuple(format_address(entry) for entry in reply_to)
    sender = message.get("from") or {}
    rendered = format_address(sender) if isinstance(sender, dict) else ""
    return (rendered, ) if rendered else ()


def quote_text(source_text: str, headline: str) -> str:
    """Quote a source body, one leading '>' per line.

    Args:
        source_text (str): the source message's text body.
        headline (str): literal line placed above the quote, or "".
    """
    trimmed = source_text.strip()
    if not trimmed:
        return ""
    lines: list[str] = []
    if headline.strip():
        lines.append(headline.rstrip("\n"))
    for line in trimmed.splitlines():
        lines.append(f">{line}" if line.startswith(">") else f"> {line}")
    return "\n".join(lines)


def compose_body(user_body: str, quote: str, signature: str,
                 style: PostingStyle) -> str:
    """Lay out the user's body, the quoted source and the signature.

    Args:
        user_body (str): the user's own text.
        quote (str): the already-quoted source body, or "".
        signature (str): signature text, or "".
        style (PostingStyle): user body above or below the quote.
    """
    body = user_body.rstrip("\n")
    if quote:
        if not body:
            body = quote
        elif style == "bottom":
            body = f"{quote}\n\n{body}"
        else:
            body = f"{body}\n\n{quote}"
    if signature.strip():
        body = f"{body}\n\n-- \n" + signature.rstrip("\n")
    return body


def build(compose: Compose, source: Source | None = None) -> EmailMessage:
    """Assemble an RFC 5322 message from flags and an optional source.

    Args:
        compose (Compose): the header and body fields.
        source (Source | None): the replied-to or forwarded message.

    Raises:
        ValueError: the message would have no recipient.
    """
    message = EmailMessage()
    message["From"] = compose.sender
    recipients = compose.to
    subject = compose.subject
    source_text = ""
    if source is not None:
        original = source.message
        prefix = PREFIXES[source.mode]
        original_subject = str(original.get("subject", ""))
        if subject is None:
            subject = (original_subject if has_prefix(original_subject, prefix)
                       else f"{prefix}{original_subject}")
        if source.mode == "reply" and not recipients:
            recipients = reply_recipients(original)
        message_id = str(original.get("message_id", ""))
        if message_id:
            if source.mode == "reply":
                message["In-Reply-To"] = message_id
            references = [*(original.get("references") or []), message_id]
            message["References"] = " ".join(references)
        source_text = str(original.get("body_text", ""))
    if not recipients:
        raise ValueError("no recipient: pass --to")
    message["To"] = ", ".join(recipients)
    if compose.cc:
        message["Cc"] = ", ".join(compose.cc)
    if compose.bcc:
        message["Bcc"] = ", ".join(compose.bcc)
    message["Subject"] = subject or ""
    style: PostingStyle = source.posting_style if source else "top"
    headline = source.quote_headline if source else ""
    body = compose_body(compose.body, quote_text(source_text, headline),
                        compose.signature or "", style)
    message.set_content(body)
    for attachment in compose.attachments:
        maintype, _, subtype = attachment.content_type.partition("/")
        message.add_attachment(attachment.data,
                               maintype=maintype,
                               subtype=subtype,
                               filename=attachment.filename)
    if compose.attachments:
        message.set_boundary(mixed_boundary(body, compose.attachments))
    return message


async def read_body(fl: FlagView, stdin: ByteSource | None) -> str:
    """Resolve the body from --body, falling back to piped stdin.

    Args:
        fl (FlagView): the leaf's parsed flags.
        stdin (ByteSource | None): piped input.
    """
    inline = fl.as_str("body")
    if inline is not None:
        return inline
    return (await materialize(stdin)).decode(errors="replace") if stdin else ""

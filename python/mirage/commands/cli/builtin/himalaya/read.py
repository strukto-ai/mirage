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

from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.attachment import (
    part_mime,
    part_name,
    part_payload,
)
from mirage.commands.cli.builtin.himalaya.printer import notice
from mirage.commands.cli.builtin.himalaya.table import format_size
from mirage.commands.cli.builtin.himalaya.util import fetch_source
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import store_flags
from mirage.core.email.mime import (
    MimeMessage,
    content_type_of,
    header_value,
    parse_mime,
)
from mirage.core.render.json import compact_json_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

DAYS = ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
MONTH_NAMES = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
PARSE_FAILURE = "Failed to parse RFC 5322 message"
SEEN_FLAG = "\\Seen"


def _day_of_week(year: int, month: int, day: int) -> int:
    offsets = (0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4)
    if month < 3:
        year -= 1
    return (
        year + year // 4 - year // 100 + year // 400 + offsets[month - 1] + day
    ) % 7


def _rfc822(value: dict[str, Any]) -> str:
    negative = value["tz_before_gmt"] and (
        value["tz_hour"] > 0 or value["tz_minute"] > 0
    )
    weekday = DAYS[_day_of_week(value["year"], value["month"], value["day"])]
    return (
        f"{weekday}, {value['day']} {MONTH_NAMES[value['month'] - 1]} "
        f"{value['year']:04d} {value['hour']:02d}:{value['minute']:02d}:"
        f"{value['second']:02d} {'-' if negative else '+'}"
        f"{value['tz_hour']:02d}{value['tz_minute']:02d}"
    )


def _address_text(entry: dict[str, Any]) -> str:
    email = entry["address"] or ""
    return f"{entry['name']} <{email}>" if entry["name"] else email


def _addresses(value: Any) -> str | None:
    if not (
        isinstance(value, dict) and isinstance(value.get("Address"), dict)
    ):
        return None
    address = value["Address"]
    if "List" in address:
        return ", ".join(map(_address_text, address["List"]))
    return ", ".join(
        _address_text(entry)
        for group in address["Group"]
        for entry in group["addresses"]
    )


def _format_content(content: dict[str, Any]) -> str:
    subtype = content["c_subtype"]
    out = f"{content['c_type']}/{subtype}" if subtype else content["c_type"]
    for attribute in content.get("attributes") or []:
        out += f"; {attribute['name']}={attribute['value']}"
    return out


def _is_html_only(message: MimeMessage) -> bool:
    html = sum(1 for part in message.parts if "Html" in part["body"])
    plain = sum(1 for part in message.parts if "Text" in part["body"])
    return html == 1 and plain == 0


def _text_of(value: Any) -> str | None:
    if isinstance(value, dict) and isinstance(value.get("Text"), str):
        return str(value["Text"])
    return None


def _first_text(value: Any) -> str | None:
    if isinstance(value, dict) and isinstance(value.get("TextList"), list):
        return str(value["TextList"][0])
    return _text_of(value)


def _render_part(part: dict[str, Any], position: int, html_only: bool) -> str:
    headers = part["headers"]
    body = part["body"]
    mime = part_mime(headers) or (
        "text/html"
        if "Html" in body
        else "text/plain"
        if "Text" in body
        else "application/octet-stream"
    )
    size = format_size(len(part_payload(body)))
    name = part_name(headers)
    label = (
        f"[{position}] {mime} — {name} ({size})"
        if name
        else f"[{position}] {mime} ({size})"
    )
    lines = ["", label]
    content = content_type_of(headers, "content_type")
    if content is not None:
        lines.append(f"    Content-Type: {_format_content(content)}")
    encoding = _text_of(header_value(headers, "content_transfer_encoding"))
    if encoding is not None:
        lines.append(f"    Content-Transfer-Encoding: {encoding}")
    disposition = content_type_of(headers, "content_disposition")
    if disposition is not None:
        lines.append(
            f"    Content-Disposition: {_format_content(disposition)}"
        )
    content_id = _first_text(header_value(headers, "content_id"))
    if content_id is not None:
        lines.append(f"    Content-ID: {content_id}")
    description = _text_of(header_value(headers, "content_description"))
    if description is not None:
        lines.append(f"    Content-Description: {description}")
    text = body.get("Html") if html_only else body.get("Text")
    if isinstance(text, str) and text.strip():
        lines += ["", text.strip()]
    return "\n".join(lines) + "\n"


def message_view(message: MimeMessage) -> str:
    """A message as `message read` shows it.

    Args:
        message (MimeMessage): the parsed message.
    """
    top = message.parts[0]["headers"]
    out = ""
    date = header_value(top, "date")
    if isinstance(date, dict) and "DateTime" in date:
        out += f"Date: {_rfc822(date['DateTime'])}\n"
    for title, name in (("From", "from"), ("To", "to"), ("Cc", "cc")):
        rendered_addresses = _addresses(header_value(top, name))
        if rendered_addresses is not None:
            out += f"{title}: {rendered_addresses}\n"
    subject = _text_of(header_value(top, "subject"))
    if subject is not None:
        out += f"Subject: {subject}\n"
    html_only = _is_html_only(message)
    for index, part in enumerate(message.parts):
        if "Multipart" in part["body"]:
            continue
        out += _render_part(part, index + 1, html_only)
    return out


async def read(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    uid = texts[0]
    mailbox = fl.as_str("mailbox", "INBOX")
    raw = await fetch_source(accessor, mailbox, uid)
    if fl.as_bool("seen"):
        await store_flags(accessor, mailbox, [uid], [SEEN_FLAG], "add")
    if fl.as_bool("raw"):
        if fl.as_bool("json"):
            return notice(fl, raw.decode("utf-8", "replace")), IOResult()
        return raw, IOResult()
    message = parse_mime(raw)
    if message is None:
        raise ValueError(PARSE_FAILURE)
    if fl.as_bool("json"):
        return compact_json_bytes(message.as_document()), IOResult()
    return message_view(message).encode(), IOResult()

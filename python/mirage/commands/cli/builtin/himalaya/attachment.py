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

from dataclasses import dataclass
from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.printer import rendered
from mirage.commands.cli.builtin.himalaya.table import (
    Cell,
    Row,
    format_size,
    render_table,
)
from mirage.commands.cli.builtin.himalaya.util import fetch_source
from mirage.commands.cli.operand import ensure_dir
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.mime import (
    MimeMessage,
    attribute_of,
    content_type_of,
    parse_mime,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.workspace.files import Files

MAX_NAME_TRIES = 1024
PARSE_FAILURE = "Failed to parse RFC 5322 message"


@dataclass(frozen=True, slots=True)
class AttachmentRow:
    """One attachment of a message.

    Args:
        id (str): the part's position, 1-based.
        filename (str | None): the name the message gives it.
        mime (str | None): the part's MIME type.
        payload (bytes): the decoded contents.
        inline (bool): whether the part is marked inline.
    """

    id: str
    filename: str | None
    mime: str | None
    payload: bytes
    inline: bool


def part_name(headers: list[dict[str, Any]]) -> str | None:
    """The file name a part carries.

    Args:
        headers (list[dict[str, Any]]): the part's headers.
    """
    return attribute_of(
        content_type_of(headers, "content_disposition"), "filename"
    ) or attribute_of(content_type_of(headers, "content_type"), "name")


def part_mime(headers: list[dict[str, Any]]) -> str | None:
    """A part's MIME type as `type/subtype`.

    Args:
        headers (list[dict[str, Any]]): the part's headers.
    """
    content = content_type_of(headers, "content_type")
    if content is None:
        return None
    subtype = content["c_subtype"]
    return f"{content['c_type']}/{subtype}" if subtype else content["c_type"]


def part_payload(body: dict[str, Any]) -> bytes:
    """A part's decoded contents.

    Args:
        body (dict[str, Any]): the part's body.
    """
    for kind in ("Text", "Html"):
        if kind in body:
            return str(body[kind]).encode()
    for kind in ("Binary", "InlineBinary"):
        if kind in body:
            return bytes(body[kind])
    return bytes(body["Message"].raw) if "Message" in body else b""


def attachment_rows(message: MimeMessage) -> list[AttachmentRow]:
    """Every attachment of a parsed message, in order.

    Args:
        message (MimeMessage): the parsed message.
    """
    rows = []
    for part_id in message.attachments:
        part = message.parts[part_id]
        headers = part["headers"]
        disposition = content_type_of(headers, "content_disposition")
        rows.append(
            AttachmentRow(
                id=str(part_id + 1),
                filename=part_name(headers),
                mime=part_mime(headers),
                payload=part_payload(part["body"]),
                inline=disposition is not None
                and disposition["c_type"].lower() == "inline",
            )
        )
    return rows


async def _rows_of(
    accessor: EmailAccessor, mailbox: str, uid: str
) -> list[AttachmentRow]:
    raw = await fetch_source(accessor, mailbox, uid)
    message = parse_mime(raw)
    if message is None:
        raise ValueError(PARSE_FAILURE)
    return attachment_rows(message)


def _document(row: AttachmentRow, path: str | None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": row.id,
        "filename": row.filename,
        "mime": row.mime,
        "size": len(row.payload),
        "inline": row.inline,
    }
    if path is not None:
        entry["path"] = path
    return entry


def _table(
    rows: list[AttachmentRow],
    paths: list[str] | None,
    with_inline: bool,
) -> str:
    titles = ["ID", "FILENAME", "TYPE", "SIZE"]
    if with_inline:
        titles.append("INLINE")
    if paths is not None:
        titles.append("PATH")
    body = []
    for index, row in enumerate(rows):
        cells = [
            Cell(row.id),
            Cell(row.filename or ""),
            Cell(row.mime or ""),
            Cell(format_size(len(row.payload))),
        ]
        if with_inline:
            cells.append(Cell("yes" if row.inline else "no"))
        if paths is not None:
            cells.append(Cell(paths[index]))
        body.append(Row(tuple(cells)))
    header = Row(tuple(Cell(title) for title in titles), None)
    return f"\n{render_table(header, body)}\n"


def _safe_name(name: str) -> str:
    """A file name a hostile header cannot climb out of the directory with.

    Args:
        name (str): the name the message gave.
    """
    cleaned = "".join("_" if c in "/\\\0" else c for c in name.strip())
    return cleaned.lstrip(".").strip() or "attachment"


async def _unique_path(vfs: Files, directory: PathSpec, name: str) -> PathSpec:
    """A path in the directory that does not exist yet.

    Args:
        vfs (Files): the session's files.
        directory (PathSpec): where the file goes.
        name (str): the file's name.
    """
    candidate = directory.join(name)
    if not await vfs.exists(candidate):
        return candidate
    stem, dot, extension = name.rpartition(".")
    if not stem:
        stem, dot, extension = name, "", ""
    for n in range(1, MAX_NAME_TRIES):
        candidate = directory.join(f"{stem} ({n}){dot}{extension}")
        if not await vfs.exists(candidate):
            return candidate
    return directory.join(name)


async def attachment_list(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    with_inline = fl.as_bool("inline")
    rows = [
        row
        for row in await _rows_of(
            accessor, fl.as_str("mailbox", "INBOX"), texts[0]
        )
        if with_inline or not row.inline
    ]
    out = rendered(
        fl,
        {"attachments": [_document(row, None) for row in rows]},
        _table(rows, None, with_inline),
    )
    return out, IOResult()


async def attachment_download(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    uid = texts[0]
    if ctx.vfs is None:
        raise ValueError("attachment download needs a workspace")
    rows = await _rows_of(accessor, fl.as_str("mailbox", "INBOX"), uid)
    directory = fl.as_path("dir") or PathSpec.from_str_path(".", cwd=ctx.cwd)
    await ensure_dir(ctx.vfs, directory)
    remaining = set(texts[1:])
    written: list[AttachmentRow] = []
    written_paths: list[str] = []
    for row in rows:
        if texts[1:] and row.id not in remaining:
            continue
        remaining.discard(row.id)
        name = _safe_name(row.filename or f"attachment-{row.id}")
        path = await _unique_path(ctx.vfs, directory, name)
        await ctx.vfs.write(path, row.payload)
        written.append(row)
        written_paths.append(path.virtual)
    if remaining:
        raise ValueError(
            f"No attachment with id {', '.join(sorted(remaining))} "
            f"on message `{uid}`"
        )
    documents = [
        _document(row, path)
        for row, path in zip(written, written_paths, strict=True)
    ]
    with_inline = any(row.inline for row in written)
    out = rendered(
        fl,
        {"attachments": documents},
        _table(written, written_paths, with_inline),
    )
    return out, IOResult()

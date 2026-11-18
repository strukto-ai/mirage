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
from mirage.core.email.mime import Attachment, parse_attachments
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.workspace.files import Files

MAX_NAME_TRIES = 1024


async def _rows_of(
    accessor: EmailAccessor, mailbox: str, uid: str, *, payloads: bool
) -> list[Attachment]:
    return parse_attachments(
        await fetch_source(accessor, mailbox, uid), payloads=payloads
    )


def _document(row: Attachment, path: str | None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": row.id,
        "filename": row.filename,
        "mime": row.mime,
        "size": row.size,
        "inline": row.inline,
    }
    if path is not None:
        entry["path"] = path
    return entry


def _table(
    rows: list[Attachment],
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
            Cell(format_size(row.size)),
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
            accessor, fl.as_str("mailbox", "INBOX"), texts[0], payloads=False
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
    rows = await _rows_of(
        accessor, fl.as_str("mailbox", "INBOX"), uid, payloads=True
    )
    directory = fl.as_path("dir") or PathSpec.from_str_path(".", cwd=ctx.cwd)
    await ensure_dir(ctx.vfs, directory)
    remaining = set(texts[1:])
    written: list[Attachment] = []
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

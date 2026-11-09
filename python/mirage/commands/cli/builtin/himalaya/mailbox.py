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
    render_table,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import list_folder_entries, mailbox_counts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

NOSELECT = "\\noselect"


def _count_cell(value: Any) -> Cell:
    return Cell("" if value is None else str(value))


async def mailbox_list(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    with_counts = fl.as_bool("counts")
    entries: list[dict[str, Any]] = []
    for name, attributes in await list_folder_entries(accessor):
        if any(attribute.lower() == NOSELECT for attribute in attributes):
            continue
        total, unread = (
            await mailbox_counts(accessor, name)
            if with_counts
            else (None, None)
        )
        inbox = name.upper() == "INBOX"
        label = "Inbox" if inbox else name
        role = (
            "inbox"
            if inbox
            else "trash"
            if name == accessor.config.trash_folder
            else "sent"
            if name == accessor.config.sent_folder
            else None
        )
        entries.append(
            {
                "id": label,
                "name": label,
                "role": role,
                "total": total,
                "unread": unread,
            }
        )
    header = ["ID", "NAME", "ROLE"] + (
        ["TOTAL", "UNREAD"] if with_counts else []
    )
    rows = []
    for entry in entries:
        cells = [
            Cell(str(entry["id"])),
            Cell(str(entry["name"])),
            Cell(str(entry["role"] or "")),
        ]
        if with_counts:
            cells += [
                _count_cell(entry["total"]),
                _count_cell(entry["unread"]),
            ]
        rows.append(Row(tuple(cells)))
    table = render_table(
        Row(tuple(Cell(title) for title in header), None),
        rows,
        fl.as_int("max_width"),
    )
    out = rendered(fl, {"mailboxes": entries}, f"\n{table}\n")
    return out, IOResult()

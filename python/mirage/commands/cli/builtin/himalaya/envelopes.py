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

from datetime import datetime, timedelta
from typing import Any

from mirage.commands.cli.builtin.himalaya.table import (
    Cell,
    Row,
    format_size,
    render_table,
)

UNSEEN_CHAR = "*"
REPLIED_CHAR = "R"
FLAGGED_CHAR = "!"
ATTACHMENT_CHAR = "@"


def _flags_cell(flags: list[Any]) -> str:
    names = {flag["iana"] for flag in flags}
    return (
        (" " if "seen" in names else UNSEEN_CHAR)
        + (REPLIED_CHAR if "answered" in names else " ")
        + (FLAGGED_CHAR if "flagged" in names else " ")
    )


def _date_cell(value: str | None) -> str:
    if not value:
        return ""
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    offset = stamp.utcoffset() or timedelta(0)
    sign = "-" if offset < timedelta(0) else "+"
    minutes = abs(int(offset.total_seconds())) // 60
    return (
        f"{stamp:%Y-%m-%d %H:%M}{sign}{minutes // 60:02d}:{minutes % 60:02d}"
    )


def _address_cell(entries: list[Any]) -> str:
    return ", ".join(entry["name"] or entry["email"] for entry in entries)


def envelopes_table(
    documents: list[dict[str, Any]],
    with_attachment: bool,
    recipient: bool,
    max_width: int | None,
) -> str:
    """The listing a human reads.

    Args:
        documents (list[dict[str, Any]]): the rendered envelopes.
        with_attachment (bool): show the ATT column.
        recipient (bool): show recipients instead of senders.
        max_width (int | None): the width to squeeze the table into.
    """
    titles: list[Cell] = [Cell("ID"), Cell("FLAGS")]
    if with_attachment:
        titles.append(Cell("ATT"))
    titles += [
        Cell("SUBJECT"),
        Cell("TO" if recipient else "FROM"),
        Cell("DATE"),
        Cell("SIZE", right=True),
    ]
    rows = []
    for document in documents:
        cells = [Cell(document["id"]), Cell(_flags_cell(document["flags"]))]
        if with_attachment:
            attached = document["has-attachment"]
            cells.append(
                Cell(
                    ATTACHMENT_CHAR
                    if attached
                    else ""
                    if attached is False
                    else "?"
                )
            )
        cells += [
            Cell(document["subject"]),
            Cell(_address_cell(document["to" if recipient else "from"])),
            Cell(_date_cell(document["date"])),
            Cell(format_size(document["size"]), right=True),
        ]
        rows.append(Row(tuple(cells)))
    table = render_table(Row(tuple(titles)), rows, max_width, frozenset({0}))
    return f"\n{table}\n"

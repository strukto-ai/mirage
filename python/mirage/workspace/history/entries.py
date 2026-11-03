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


from collections.abc import Sequence

from mirage.shell.bytes import decode_text
from mirage.shell.helpers import same_line
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.workspace.history.constants import OPENERS, WORDS
from mirage.workspace.history.types import HistoryEntry


def _descendants(node: TSNodeLike) -> list[TSNodeLike]:
    return [node, *(d for c in node.children for d in _descendants(c))]


def _blanks(rows: bytes) -> list[HistoryEntry]:
    return [
        HistoryEntry(decode_text(row), None)
        for row in rows.split(b"\n")
        if row and not row.strip()
    ]


def history_entries(root: TSNodeLike) -> list[HistoryEntry]:
    """The entries bash's history adds for an input it reads
    interactively: one per command it reads, a command and what else is on
    the line it ends on. A command spanning lines is one entry, its lines
    joined as ``cmdhist`` joins them: a break inside a quoted word, a
    substitution or a heredoc stays, a backslash's goes, and any other is
    a ``; `` or, after a token a command reads on after (``then``, ``|``,
    ``{``, a case pattern's ``)``), a space. A comment line inside a
    command is dropped, a line of blanks is an entry of its own and an
    empty line none. Pinned against Debian Bash 5.2.37 with ``set +H``.
    Mirrors TypeScript's historyEntries.

    Args:
        root (TSNodeLike): the parsed input.
    """
    text_read: bytes = root.text or b""
    source: bytes = getattr(root, "source_text", None) or text_read
    base = root.start_byte
    offsets: Sequence[int] = getattr(root, "offsets", None) or ()

    def typed(index: int) -> int:
        return offsets[index] if index < len(offsets) else index

    breaks = {
        typed(base + i): base + i
        for i, byte in enumerate(text_read)
        if byte == 0x0A
    }
    groups: list[list[TSNodeLike]] = []
    for child in root.children:
        if not child.is_named:
            continue
        if groups and same_line(root, groups[-1][-1], child):
            groups[-1].append(child)
        else:
            groups.append([child])
    entries: list[HistoryEntry] = []
    read = 0
    for group in groups:
        first = group[0]
        nodes = [d for n in group for d in _descendants(n)]
        folded = [
            (n, doc)
            for n in nodes
            if (doc := getattr(n, "heredoc", None)) is not None
        ]

        def inside(node: TSNodeLike) -> bool:
            return any(
                n.start_byte <= node.start_byte and node.end_byte <= n.end_byte
                for n, _ in folded
            )

        start = source.rfind(b"\n", 0, max(0, typed(first.start_byte))) + 1
        end = max(
            [
                typed(n.end_byte - 1) + 1
                for n in nodes
                if not n.children and not inside(n)
            ]
            + [doc.end for _, doc in folded]
        )
        found = source.find(b"\n", end - 1)
        stop = len(source) if found < 0 else found
        entries.extend(_blanks(source[read:start]))
        read = stop + 1
        if any(n.type == NT.ERROR for n in nodes):
            entries.append(
                HistoryEntry(
                    decode_text(source[start:stop]), typed(first.start_byte)
                )
            )
            continue
        comments = {typed(n.start_byte) for n in nodes if n.type == NT.COMMENT}

        def within(index: int) -> bool:
            return any(
                n.type in WORDS and n.start_byte < index < n.end_byte
                for n in nodes
            )

        def joint(at: int) -> bytes:
            docs = [
                (n, doc) for n, doc in folded if doc.word_end <= at < doc.end
            ]
            if docs:
                if not all(at == doc.end - 1 for _, doc in docs):
                    return b"\n"
                if any(within(n.start_byte) for n, _ in docs):
                    return b"\n\n"
                return b"\n "
            index = breaks.get(at)
            if index is None:
                before = base
                for i in range(base, base + len(text_read)):
                    if typed(i) < at - 1:
                        before = i
                if within(before) or source[at - 1] != 0x5C:
                    return b"\n"
                return b""
            if within(index):
                return b"\n"
            if any(
                n.type == NT.ARRAY and n.start_byte < index < n.end_byte
                for n in nodes
            ):
                return b" "
            leaf: TSNodeLike | None = None
            for n in nodes:
                if (
                    not n.children
                    and n.end_byte <= index
                    and (leaf is None or n.end_byte >= leaf.end_byte)
                ):
                    leaf = n
            if leaf is None:
                return b"; "
            if leaf.type == NT.COMMENT:
                return b"\n"
            if not leaf.is_named and leaf.type in OPENERS:
                return b" "
            pattern = leaf.parent.type if leaf.parent is not None else None
            if leaf.type == ")" and pattern in (
                NT.CASE_ITEM,
                NT.FUNCTION_DEFINITION,
            ):
                return b" "
            return b"; "

        text = b""
        blank = False
        comment = False
        at = start
        while True:
            following = source.find(b"\n", at)
            ends = stop if following < 0 or following > stop else following
            row = source[at:ends]
            if at == start:
                text = row
            else:
                between = joint(at - 1)
                word = between.startswith(b"\n")
                if not word and at + len(row) - len(row.lstrip()) in comments:
                    comment = True
                else:
                    if comment:
                        joined = b"\n"
                    elif blank and not word:
                        joined = b" "
                    else:
                        joined = between
                    text = (
                        (text[:-1] if between == b"" else text) + joined + row
                    )
                    blank = not word and not row.strip()
                    comment = False
            if ends >= stop:
                break
            at = ends + 1
        if any(doc.end - 1 == stop for _, doc in folded):
            text += b"\n"
        entries.append(
            HistoryEntry(decode_text(text), typed(first.start_byte))
        )
    entries.extend(_blanks(source[read:]))
    return entries

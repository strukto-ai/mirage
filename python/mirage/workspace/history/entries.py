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


from bisect import bisect_right
from collections.abc import Iterable, Sequence

from mirage.shell.bytes import decode_text
from mirage.shell.helpers import same_line
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.workspace.history.constants import OPENERS, WORDS
from mirage.workspace.history.types import HistoryEntry


def _descendants(node: TSNodeLike) -> list[TSNodeLike]:
    nodes: list[TSNodeLike] = []
    pending = [node]
    while pending:
        current = pending.pop()
        nodes.append(current)
        pending.extend(reversed(current.children))
    return nodes


class _Spans:
    def __init__(self, spans: Iterable[tuple[int, int]]) -> None:
        self.starts: list[int] = []
        self.ends: list[int] = []
        end = -1
        for start, stop in sorted(spans):
            end = max(end, stop)
            self.starts.append(start)
            self.ends.append(end)

    def end_at(self, index: int) -> int:
        at = bisect_right(self.starts, index) - 1
        return self.ends[at] if at >= 0 else -1

    def contains(self, index: int) -> bool:
        return index < self.end_at(index)


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
    removed: dict[int, int] | None = None

    def before(at: int) -> int:
        nonlocal removed
        if removed is None:
            missing: list[int] = []
            newline = source.find(b"\n")
            while newline >= 0:
                if newline not in breaks:
                    missing.append(newline)
                newline = source.find(b"\n", newline + 1)
            removed = dict.fromkeys(missing, base)
            pending = len(missing)
            # Reverse logical order preserves the last match even in a moved heredoc.
            for i in range(base + len(text_read) - 1, base - 1, -1):
                if not pending:
                    break
                original = typed(i) + 1
                if original < missing[pending - 1]:
                    first = bisect_right(missing, original, 0, pending)
                    for newline in missing[first:pending]:
                        removed[newline] = i
                    pending = first
        return removed[at]

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

        doc_spans = _Spans((n.start_byte, n.end_byte) for n, _ in folded)
        leaves = [n for n in nodes if not n.children]

        start = source.rfind(b"\n", 0, max(0, typed(first.start_byte))) + 1
        end = max(
            [
                typed(n.end_byte - 1) + 1
                for n in leaves
                if doc_spans.end_at(n.start_byte) < n.end_byte
            ]
            + [doc.end for _, doc in folded]
        )
        found = source.find(b"\n", end - 1)
        stop = len(source) if found < 0 else found
        entries.extend(_blanks(source[read:start]))
        read = stop + 1
        if (newline := source.find(b"\n", start)) < 0 or newline >= stop:
            text = source[start:stop]
            if any(doc.end - 1 == stop for _, doc in folded):
                text += b"\n"
            entries.append(
                HistoryEntry(decode_text(text), typed(first.start_byte))
            )
            continue
        if any(n.type == NT.ERROR for n in nodes):
            entries.append(
                HistoryEntry(
                    decode_text(source[start:stop]), typed(first.start_byte)
                )
            )
            continue
        comments = {typed(n.start_byte) for n in nodes if n.type == NT.COMMENT}
        words = _Spans(
            (n.start_byte + 1, n.end_byte) for n in nodes if n.type in WORDS
        )
        arrays = _Spans(
            (n.start_byte + 1, n.end_byte) for n in nodes if n.type == NT.ARRAY
        )
        docs = _Spans((doc.word_end, doc.end) for _, doc in folded)
        nested_docs = _Spans(
            (doc.word_end, doc.end)
            for n, doc in folded
            if words.contains(n.start_byte)
        )
        leaves.sort(key=lambda n: n.end_byte)
        leaf_ends = [n.end_byte for n in leaves]

        def joint(at: int) -> bytes:
            doc_end = docs.end_at(at)
            if at < doc_end:
                if at != doc_end - 1:
                    return b"\n"
                if nested_docs.contains(at):
                    return b"\n\n"
                return b"\n "
            index = breaks.get(at)
            if index is None:
                if words.contains(before(at)) or source[at - 1] != 0x5C:
                    return b"\n"
                return b""
            if words.contains(index):
                return b"\n"
            if arrays.contains(index):
                return b" "
            previous = bisect_right(leaf_ends, index) - 1
            if previous < 0:
                return b"; "
            leaf = leaves[previous]
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

        chunks: list[bytes] = []
        blank = False
        comment = False
        at = start
        while True:
            following = source.find(b"\n", at)
            ends = stop if following < 0 or following > stop else following
            row = source[at:ends]
            if at == start:
                chunks.append(row)
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
                    if between == b"":
                        while chunks and not chunks[-1]:
                            chunks.pop()
                        if chunks:
                            chunks[-1] = chunks[-1][:-1]
                    chunks.extend((joined, row))
                    blank = not word and not row.strip()
                    comment = False
            if ends >= stop:
                break
            at = ends + 1
        if any(doc.end - 1 == stop for _, doc in folded):
            chunks.append(b"\n")
        entries.append(
            HistoryEntry(
                decode_text(b"".join(chunks)), typed(first.start_byte)
            )
        )
    entries.extend(_blanks(source[read:]))
    return entries

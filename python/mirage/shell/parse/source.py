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
from typing import Any, cast

import tree_sitter

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse.constants import VERBATIM_TYPES
from mirage.shell.parse.engine import TS_PARSER
from mirage.shell.parse.heredoc.constants import BACKSLASH
from mirage.shell.parse.heredoc.lower import (
    drop_bytes,
    drop_source_bytes,
    rebase_source,
)
from mirage.shell.parse.heredoc.node import HeredocNode
from mirage.shell.parse.heredoc.types import HeredocSource
from mirage.shell.parse.program import ProgramNode
from mirage.shell.parse.timing import PrefixNode
from mirage.shell.types import TSNodeLike


class SourceNode:
    """A node of a shielded parse that reads the original bytes.

    Every shield keeps the source's width, so a span names the same bytes
    in both. Text and row/column positions use the original source:
    pattern shielding can hide a newline inside a word. Reparsing against the
    shielded tree did the same until tree-sitter relexed a statement on
    its own, which it does at a line's end.
    """

    def __init__(
        self,
        node: tree_sitter.Node,
        data: bytes,
        lines: tuple[int, ...] | None = None,
    ) -> None:
        self._node = node
        self._data = data
        self._lines = (
            lines
            if lines is not None
            else (0, *(i + 1 for i, c in enumerate(data) if c == 10))
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._node, name)

    def _wrap(self, node: tree_sitter.Node | None) -> "SourceNode | None":
        return (
            None if node is None else SourceNode(node, self._data, self._lines)
        )

    @property
    def text(self) -> bytes:
        return self._data[self._node.start_byte : self._node.end_byte]

    def _point(self, at: int) -> tuple[int, int]:
        row = bisect_right(self._lines, at) - 1
        return row, at - self._lines[row]

    @property
    def start_point(self) -> tuple[int, int]:
        return self._point(self._node.start_byte)

    @property
    def end_point(self) -> tuple[int, int]:
        return self._point(self._node.end_byte)

    @property
    def children(self) -> list["SourceNode"]:
        return [
            cast(SourceNode, self._wrap(node)) for node in self._node.children
        ]

    @property
    def named_children(self) -> list["SourceNode"]:
        return [
            cast(SourceNode, self._wrap(node))
            for node in self._node.named_children
        ]

    @property
    def parent(self) -> "SourceNode | None":
        return self._wrap(self._node.parent)

    @property
    def prev_sibling(self) -> "SourceNode | None":
        return self._wrap(self._node.prev_sibling)

    @property
    def next_sibling(self) -> "SourceNode | None":
        return self._wrap(self._node.next_sibling)

    def child_by_field_name(self, name: str) -> "SourceNode | None":
        return self._wrap(self._node.child_by_field_name(name))


def _verbatim_spans(root: TSNodeLike) -> list[tuple[int, int]]:
    """Byte spans whose backslashes escape nothing: comments and strings
    in single quotes, ANSI-C ones included.

    Args:
        root (TSNodeLike): root of the parsed tree.
    """
    spans: list[tuple[int, int]] = []
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type in VERBATIM_TYPES:
            spans.append((node.start_byte, node.end_byte))
            continue
        stack.extend(node.children)
    return sorted(spans)


def continuation_bytes(data: bytes) -> list[int]:
    """Offsets of the bytes bash's reader deletes as line continuations.

    The reader removes ``\\<newline>`` before a token is read, so the
    halves it joins are one word (``a\\<newline>b`` is ``ab``,
    ``$\\<newline>{x}`` an expansion); tree-sitter reads the pair as
    whitespace instead. Single-quoted and ANSI-C text and a comment keep
    theirs, and an escaped backslash continues nothing: only an
    odd-length run of backslashes before the newline ends in a live one.
    A live backslash ending the input continues onto nothing and goes
    too: ``echo a\\`` runs ``echo a``. A heredoc body is lowered into a
    quoted word before this runs, where every backslash it holds is
    escaped, so no body loses a byte here.

    Args:
        data (bytes): shell source.
    """
    if b"\\\n" not in data and not data.endswith(b"\\"):
        return []
    spans = _verbatim_spans(TS_PARSER.parse(data).root_node)
    dropped: list[int] = []
    at = 0
    index = data.find(b"\\")
    while index >= 0:
        end = index
        while end < len(data) and data[end] == BACKSLASH:
            end += 1
        while at < len(spans) and spans[at][1] <= end - 1:
            at += 1
        verbatim = at < len(spans) and spans[at][0] <= end - 1
        if (
            (end - index) % 2
            and not verbatim
            and data[end : end + 1] in (b"", b"\n")
        ):
            dropped.extend(range(end - 1, min(end + 1, len(data))))
        index = data.find(b"\\", end)
    return dropped


def source_offsets(command: str, root: TSNodeLike) -> tuple[int, ...]:
    """Where each byte of the source ``parse`` read sits in ``command``.

    ``parse`` deletes line continuations and inserts bytes to repair the
    grammar, so a node's offsets index the source it read rather than the
    line as typed. Indexed by one of them, this gives the byte of
    ``command`` it came from; an inserted byte gives the byte after it.

    Args:
        command (str): the line ``root`` was parsed from.
        root (TSNodeLike): what ``parse(command)`` returned.
    """
    if isinstance(root, ProgramNode) and root.program.original == command:
        return root.program.offsets
    if isinstance(root, HeredocNode | PrefixNode):
        return root.offsets
    data = encode_text(command)
    source = drop_source_bytes(
        HeredocSource(data, data, tuple(range(len(data) + 1)), ()),
        continuation_bytes(data),
    )
    repaired = source.source[: root.start_byte] + (root.text or b"")
    return rebase_source(source, repaired).offsets


def join_continuations(command: str) -> str:
    """The line as bash's reader hands it on, continuations removed.

    Args:
        command (str): the raw command line.
    """
    data = encode_text(command)
    return decode_text(drop_bytes(data, continuation_bytes(data)))

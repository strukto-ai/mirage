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

from mirage.shell.bytes import encode_text
from mirage.shell.parse.heredoc.line import ends_escaped
from mirage.shell.parse.heredoc.types import Heredoc, HeredocSource
from mirage.shell.types import TSNodeLike


class HeredocNode:
    """Tree-sitter's node interface with reader-owned input metadata.

    All nodes in a tree share one source record. There is no global node
    registry, so stored functions keep their input and concurrent parses
    cannot overwrite one another's documents.
    """

    def __init__(self, node: TSNodeLike, source: HeredocSource):
        self._node = node
        self._source = source

    def __getattr__(self, name: str) -> Any:
        return getattr(self._node, name)

    def _wrap(self, node: TSNodeLike | None) -> "HeredocNode | None":
        return None if node is None else HeredocNode(node, self._source)

    @property
    def children(self) -> list["HeredocNode"]:
        return [
            HeredocNode(node, self._source) for node in self._node.children
        ]

    @property
    def named_children(self) -> list["HeredocNode"]:
        return [
            HeredocNode(node, self._source)
            for node in self._node.named_children
        ]

    @property
    def parent(self) -> "HeredocNode | None":
        return self._wrap(self._node.parent)

    @property
    def prev_sibling(self) -> "HeredocNode | None":
        return self._wrap(self._node.prev_sibling)

    @property
    def next_sibling(self) -> "HeredocNode | None":
        return self._wrap(self._node.next_sibling)

    def child_by_field_name(self, name: str) -> "HeredocNode | None":
        return self._wrap(self._node.child_by_field_name(name))

    @property
    def heredoc(self) -> Heredoc | None:
        if self.type != "file_redirect":
            return None
        return next(
            (
                doc
                for start, doc in self._source.documents
                if any(
                    child.type == "<" and child.start_byte == start
                    for child in self._node.children
                )
            ),
            None,
        )

    @property
    def warnings(self) -> bytes:
        """What bash warns of while it reads the line's heredocs, in the
        order it reads them: a substitution closing with bodies still to
        read, on the line its reader stands on then, and a body the input
        ends inside."""
        original = self._source.original
        closes = {
            opened[0]: (close, opened) for close, opened in self._source.closes
        }
        out: list[str] = []
        previous: Heredoc | None = None
        for doc in sorted(
            (doc for _, doc in self._source.documents),
            key=lambda doc: doc.body_start,
        ):
            if doc.operator_start in closes:
                close, opened = closes[doc.operator_start]
                line = original.count(b"\n", 0, close) + 1
                if previous is not None:
                    line = max(
                        line, original.count(b"\n", 0, previous.end - 1) + 1
                    )
                count = len(opened)
                plural = "s" if count > 1 else ""
                out.append(
                    f"mirage: line {line}: warning: command substitution: "
                    f"{count} unterminated here-document{plural}\n"
                )
            if not doc.terminated:
                out.append(
                    f"mirage: line {doc.eof_line}: warning: here-document at "
                    f"line {doc.line} delimited by end-of-file (wanted "
                    f"`{doc.delimiter}')\n"
                )
            previous = doc
        return encode_text("".join(out))

    @property
    def offsets(self) -> tuple[int, ...]:
        return self._source.offsets

    @property
    def source_text(self) -> bytes:
        """The node's own text in the line as typed: its heredoc bodies
        included where they sit inside it, not those it carries out."""
        if self._node.parent is None:
            return self._source.original
        if not any(
            self.start_byte <= start < self.end_byte
            for start, _ in self._source.documents
        ):
            return self._node.text or b""
        if self.end_byte <= self.start_byte:
            return b""
        offsets = self._source.offsets
        start, end = offsets[self.start_byte], offsets[self.end_byte - 1]
        return self._source.original[start : end + 1]

    @property
    def inlined(self) -> bytes:
        """The node's own text with each heredoc body the line reads after
        a substitution in it moved inside that substitution, just before
        its ``)``, and out of the node's text where it sat there: the same
        command to bash, and what a substitution's line runs as, carrying no
        heredoc out of itself. A body the input ended inside gets its
        terminator on a line of its own. Empty when no substitution in the
        node carries one out."""
        if self._node.parent is None or self.end_byte <= self.start_byte:
            return b""
        offsets, original = self._source.offsets, self._source.original
        first, last = offsets[self.start_byte], offsets[self.end_byte - 1]
        closes = [c for c in self._source.closes if first <= c[0] <= last]
        if not closes:
            return b""
        docs = {doc.operator_start: doc for _, doc in self._source.documents}
        edits: list[tuple[int, int, bytes]] = []
        for close, opened in closes:
            bodies = bytearray(b"\n")
            for at in opened:
                doc = docs.get(at)
                if doc is None:
                    continue
                body = original[doc.body_start : doc.end]
                bodies += body
                if not bodies.endswith(b"\n"):
                    bodies += b"\n"
                if not doc.terminated:
                    line = body.removesuffix(b"\n")
                    if not doc.quoted and ends_escaped(line):
                        bodies += b"\n"
                    bodies += encode_text(doc.delimiter) + b"\n"
                if first <= doc.body_start and doc.end <= last + 1:
                    edits.append(
                        (doc.body_start - first, doc.end - first, b"")
                    )
            edits.append((close - first, close - first, bytes(bodies)))
        out = bytearray(self.source_text)
        for start, end, replacement in sorted(edits, reverse=True):
            out[start:end] = replacement
        return bytes(out)

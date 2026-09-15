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

import tree_sitter

from mirage.shell.parse.heredoc.types import Heredoc, HeredocSource


class HeredocNode:
    """Tree-sitter's node interface with reader-owned input metadata.

    All nodes in a tree share one source record. There is no global node
    registry, so stored functions keep their input and concurrent parses
    cannot overwrite one another's documents.
    """

    def __init__(self, node: tree_sitter.Node, source: HeredocSource):
        self._node = node
        self._source = source

    def __getattr__(self, name: str) -> Any:
        return getattr(self._node, name)

    def _wrap(self, node: tree_sitter.Node | None) -> "HeredocNode | None":
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
        return next((doc for start, doc in self._source.documents
                     if any(child.type == "<" and child.start_byte == start
                            for child in self._node.children)), None)

    @property
    def warnings(self) -> bytes:
        return "".join(
            f"mirage: line {doc.eof_line}: warning: here-document at line "
            f"{doc.line} delimited by end-of-file (wanted `{doc.delimiter}')\n"
            for _, doc in self._source.documents
            if not doc.terminated).encode()

    @property
    def source_text(self) -> bytes:
        if self._node.parent is None:
            return self._source.original
        if not any(self.start_byte <= start < self.end_byte
                   for start, _ in self._source.documents):
            return self._node.text or b""
        positions = self._source.offsets[self.start_byte:self.end_byte]
        if not positions:
            return b""
        return self._source.original[min(positions):max(positions) + 1]

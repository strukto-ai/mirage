import re
from dataclasses import replace
from typing import Any, cast

import tree_sitter

from mirage.shell.parse.heredoc.types import HeredocSource
from mirage.shell.parse.names import walk_tree

PREFIX = re.compile(
    rb"time(?=[ \t\r\n;|&)]|$)[ \t]*"
    rb"(?:(-p)(?=[ \t\r\n;|&)]|$)[ \t]*)?"
    rb"(?:--(?=[ \t\r\n;|&)]|$)[ \t]*)?"
)
COMPOUND_HEADS = frozenset(
    {
        b"{",
        b"if",
        b"for",
        b"select",
        b"while",
        b"until",
        b"case",
        b"!",
        b"time",
    }
)
STATEMENTS = frozenset(
    {
        "command",
        "test_command",
        "arithmetic_expansion",
        "pipeline",
        "redirected_statement",
        "negated_command",
        "subshell",
        "compound_statement",
        "if_statement",
        "for_statement",
        "while_statement",
        "case_statement",
        "c_style_for_statement",
    }
)


def lower_timing(
    parser: tree_sitter.Parser, source: HeredocSource
) -> tuple[HeredocSource, list[tuple[int, str, bool, int, int]]]:
    """Remove reserved prefixes before parsing their pipeline/compound body.

    Args:
        parser (tree_sitter.Parser): Bash parser used for command positions.
        source (HeredocSource): source map after gathering input documents.
    """
    data = source.source
    marks: list[tuple[int, str, bool, int, int]] = []
    while True:
        root = parser.parse(data).root_node
        edits: list[tuple[int, int, bytes]] = []
        for node in walk_tree(root):
            if not node.children:
                continue
            negated = node.type == "negated_command"
            if negated:
                body = node.named_children[0]
                head = body.child_by_field_name("name")
                arith = data[body.start_byte : body.start_byte + 2] == b"(("
                if not arith and (
                    head is None or head.text not in COMPOUND_HEADS
                ):
                    continue
            name = (
                node.children[0]
                if negated
                else node.child_by_field_name("name")
            )
            if name is None:
                continue
            if not negated and (
                node.type != "command"
                or name.text != b"time"
                or node.children[0].id != name.id
            ):
                continue
            parent = node.parent
            if (
                parent is not None
                and parent.type == "pipeline"
                and parent.named_children[0].id != node.id
            ):
                continue
            match = (
                PREFIX.match(data, name.start_byte) if not negated else None
            )
            if not negated and match is None:
                continue
            end = name.end_byte if match is None else match.end()
            while end < len(data) and data[end] in b" \t":
                end += 1
            empty = end == len(data) or data[end] in b"\n;&)"
            replacement = b" " * (end - name.start_byte)
            anchor = end
            if empty:
                replacement = b":" + replacement[1:]
                anchor = name.start_byte
            marks = [
                (
                    source.offsets[anchor]
                    if position == source.offsets[name.start_byte]
                    else position,
                    kind,
                    flag,
                    begin,
                    finish,
                )
                for position, kind, flag, begin, finish in marks
            ]
            marks.append(
                (
                    source.offsets[anchor],
                    "negated_command" if negated else "timed_statement",
                    match is not None and match.group(1) is not None,
                    source.offsets[name.start_byte],
                    source.offsets[end],
                )
            )
            edits.append((name.start_byte, end, replacement))
        if not edits:
            break
        for start, end, replacement in sorted(edits, reverse=True):
            data = data[:start] + replacement + data[end:]
    return replace(source, source=data), marks


class PrefixNode:
    """Preserve native node behavior while adding an execution-only wrapper."""

    def __init__(
        self,
        node: Any,
        targets: dict[int, tuple[tuple[str, bool], ...]],
        source: HeredocSource,
        spans: list[tuple[int, int]],
        skip: int = 0,
        parent: "PrefixNode | None" = None,
    ):
        self._node = node
        self._targets = targets
        self._source = source
        self._spans = spans
        self._skip = skip
        self._parent = parent
        self.prefixes = targets.get(node.id, ())[skip:]
        self.timing = (self.prefixes[0][1],) if self.prefixes else ()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._node, name)

    @property
    def type(self) -> str:
        return self.prefixes[0][0] if self.prefixes else self._node.type

    def _wrap(self, node: Any, parent: "PrefixNode | None" = None) -> Any:
        return (
            None
            if node is None
            else PrefixNode(
                node, self._targets, self._source, self._spans, parent=parent
            )
        )

    @property
    def children(self) -> list[Any]:
        if self.timing:
            return [
                PrefixNode(
                    self._node,
                    self._targets,
                    self._source,
                    self._spans,
                    self._skip + 1,
                    self,
                )
            ]
        return [self._wrap(node, self) for node in self._node.children]

    @property
    def named_children(self) -> list[Any]:
        return (
            self.children
            if self.timing
            else [self._wrap(node, self) for node in self._node.named_children]
        )

    @property
    def parent(self) -> Any:
        return self._parent or self._wrap(self._node.parent)

    @property
    def prev_sibling(self) -> Any:
        return self._wrap(self._node.prev_sibling)

    @property
    def next_sibling(self) -> Any:
        return self._wrap(self._node.next_sibling)

    @property
    def offsets(self) -> tuple[int, ...]:
        return self._source.offsets

    @property
    def source_text(self) -> bytes:
        if any(
            self.start_byte <= start < self.end_byte
            for start, _ in self._source.documents
        ):
            return cast(bytes, self._node.source_text)
        text = bytearray(self._node.text or b"")
        for index, offset in enumerate(
            self._source.offsets[self.start_byte : self.end_byte]
        ):
            if any(start <= offset < end for start, end in self._spans):
                text[index] = self._source.original[offset]
        return bytes(text)

    def child_by_field_name(self, name: str) -> Any:
        return self._wrap(self._node.child_by_field_name(name), self)


def _spans_list(node: Any) -> bool:
    """Skip grammar wrappers that extend past a prefix's &&/|| boundary.

    Args:
        node (Any): candidate statement for the reserved prefix.
    """
    while (
        node.type in ("redirected_statement", "pipeline")
        and node.named_children
    ):
        node = node.named_children[0]
    return bool(node.type == "list")


def wrap_timing(
    root: Any,
    source: HeredocSource,
    marks: list[tuple[int, str, bool, int, int]],
) -> PrefixNode:
    """Attach each prefix to the entire following pipeline, within its list.

    Args:
        root (Any): mapped parse tree.
        source (HeredocSource): final source positions.
        marks (list[tuple[int, str, bool, int, int]]): prefix positions.
    """
    targets: dict[int, tuple[tuple[str, bool], ...]] = {}
    for position, kind, portable, _, _ in marks:
        stack = [root]
        while stack:
            node = stack.pop()
            if (
                node.type in STATEMENTS
                and source.offsets[node.start_byte] == position
                and not _spans_list(node)
            ):
                prefixes = targets.get(node.id, ())
                if (
                    kind == "timed_statement"
                    and prefixes
                    and prefixes[-1][0] == kind
                ):
                    prefixes = (
                        *prefixes[:-1],
                        (kind, prefixes[-1][1] or portable),
                    )
                else:
                    prefixes = (*prefixes, (kind, portable))
                targets[node.id] = prefixes
                break
            stack.extend(reversed(node.named_children))
    return PrefixNode(
        root, targets, source, [(start, end) for _, _, _, start, end in marks]
    )

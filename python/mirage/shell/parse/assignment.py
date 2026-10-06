from typing import Any

from mirage.shell.parse.recovery import parse_protected
from mirage.shell.parse.source import SourceNode
from mirage.shell.types import TSNodeLike

MARKER = b" a="
SEPARATORS = frozenset({b";", b"&", b"&&", b"||", b"|"})
REDIRECT_RUN = frozenset({"file_redirect", "comment"})


def repair_assignments(root: TSNodeLike, data: bytes) -> TSNodeLike:
    """Select the assignment-only redirect production with an invisible second
    assignment, removed by the adapter before execution sees the tree.

    A repaired statement can expose the next one (``a=1 >f; b=2 >g`` parses
    as one command until the first is split off), so the repair repeats
    until a pass finds no new assignment.

    Args:
        root (TSNodeLike): the parsed tree to repair.
        data (bytes): the source ``root`` was parsed from.
    """
    if not root.has_error:
        return root
    positions: set[int] = set()
    current = root
    for _ in range(data.count(b"=")):
        found = _assignment_ends(current) - positions
        if not found:
            break
        positions |= found
        ordered = sorted(positions)
        amended = data
        for at in reversed(ordered):
            amended = amended[:at] + MARKER + amended[at:]
        current = AssignmentNode(
            parse_protected(amended),
            data,
            tuple(at + i * len(MARKER) for i, at in enumerate(ordered)),
        )
    return current


def _assignment_ends(root: TSNodeLike) -> set[int]:
    """Where each assignment-only redirect's assignment ends.

    Args:
        root (TSNodeLike): the tree to scan.
    """
    positions: set[int] = set()
    pending = [root]
    while pending:
        node = pending.pop()
        pending.extend(node.children)
        if node.type != "command":
            continue
        children = node.children
        if not children or children[0].type != "variable_assignment":
            continue
        at, redirects = 1, 0
        while at < len(children) and children[at].type in REDIRECT_RUN:
            redirects += children[at].type == "file_redirect"
            at += 1
        if not redirects:
            continue
        tail = children[at] if at < len(children) else None
        if tail is not None and not (
            (tail.type == "command_name" and not tail.text)
            or (
                tail.type == "ERROR"
                and (tail.text or b"").strip() in SEPARATORS
            )
        ):
            continue
        positions.add(children[0].end_byte)
    return positions


class AssignmentNode(SourceNode):
    """A node of the repaired parse that hides the inserted assignments.

    Args:
        node (Any): the node of the parse with the markers.
        data (bytes): the source without them.
        inserted (tuple[int, ...]): where each marker starts in the parse.
    """

    def __init__(
        self, node: Any, data: bytes, inserted: tuple[int, ...]
    ) -> None:
        super().__init__(node, data)
        self._inserted = inserted

    def _offset(self, index: int) -> int:
        return index - sum(
            max(0, min(len(MARKER), index - at)) for at in self._inserted
        )

    @property
    def start_byte(self) -> int:
        return self._offset(self._node.start_byte)

    @property
    def end_byte(self) -> int:
        return self._offset(self._node.end_byte)

    @property
    def text(self) -> bytes:
        return self._data[self.start_byte : self.end_byte]

    def _position(self, index: int) -> tuple[int, int]:
        before = self._data[:index]
        return before.count(b"\n"), index - before.rfind(b"\n") - 1

    @property
    def start_point(self) -> tuple[int, int]:
        return self._position(self.start_byte)

    @property
    def end_point(self) -> tuple[int, int]:
        return self._position(self.end_byte)

    def _wrap(self, node: Any) -> Any:
        return (
            None
            if node is None
            else AssignmentNode(node, self._data, self._inserted)
        )

    def _visible(self, node: Any) -> bool:
        return not (
            node.type == "variable_assignment"
            and node.start_byte - 1 in self._inserted
        )

    @property
    def children(self) -> list[Any]:
        return [self._wrap(n) for n in self._node.children if self._visible(n)]

    @property
    def named_children(self) -> list[Any]:
        return [
            self._wrap(n)
            for n in self._node.named_children
            if self._visible(n)
        ]

    @property
    def child_count(self) -> int:
        return len(self.children)

    def child(self, index: int) -> Any:
        children = self.children
        return children[index] if 0 <= index < len(children) else None

    @property
    def next_sibling(self) -> Any:
        node = self._node.next_sibling
        while node is not None and not self._visible(node):
            node = node.next_sibling
        return self._wrap(node)

    @property
    def prev_sibling(self) -> Any:
        node = self._node.prev_sibling
        while node is not None and not self._visible(node):
            node = node.prev_sibling
        return self._wrap(node)

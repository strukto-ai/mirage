from typing import Any

from mirage.shell.parse.recovery import _parse_bytes
from mirage.shell.parse.source import SourceNode
from mirage.shell.types import TSNodeLike

MARKER = b" a="
SEPARATORS = frozenset({b";", b"&", b"&&", b"||", b"|"})


def repair_assignments(root: TSNodeLike, data: bytes) -> TSNodeLike:
    """Select the assignment-only redirect production with an invisible second
    assignment, removed by the adapter before execution sees the tree."""
    if not root.has_error:
        return root
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
        at = 1
        while at < len(children) and children[at].type == "file_redirect":
            at += 1
        if at == 1:
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
    if not positions:
        return root
    amended = data
    ordered = sorted(positions)
    for at in reversed(ordered):
        amended = amended[:at] + MARKER + amended[at:]
    retried = _parse_bytes(amended)
    return AssignmentNode(
        retried,
        data,
        tuple(at + i * len(MARKER) for i, at in enumerate(ordered)),
    )


class AssignmentNode(SourceNode):
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

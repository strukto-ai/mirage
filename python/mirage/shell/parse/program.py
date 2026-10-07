from collections.abc import Callable, Sequence
from typing import Any

from mirage.shell.types import TSNodeLike


class ParsedProgram:
    """One parse of a line: its tree, where each of its bytes sits in the
    line as typed, and the references that keep it.

    Python frees the tree with the last reference to it; the count is what
    makes a read after the last release fail, as TypeScript's native tree
    is freed then.

    Args:
        original (str): the line as typed.
        root (TSNodeLike): the parsed tree.
        offsets (tuple[int, ...]): ``source_offsets(original, root)``.
    """

    def __init__(
        self, original: str, root: TSNodeLike, offsets: tuple[int, ...]
    ) -> None:
        self.original = original
        self.offsets = offsets
        self.references = 1
        self._released = False
        self.root = ProgramNode(root, self)

    def check(self) -> None:
        if self.references == 0:
            raise RuntimeError("parsed program is released")

    def retain(self) -> Callable[[], None]:
        self.check()
        self.references += 1
        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self.references -= 1

        return release

    def release(self) -> None:
        if not self._released:
            self._released = True
            self.references -= 1


class ProgramNode:
    """A node of a parsed program; every read checks the program is held.

    The wrappers of a node's children are built once and kept, so a walk
    pays for each wrapper one time, and the attributes walks read most go
    straight to the node.

    Args:
        node (TSNodeLike): the node it reads.
        program (ParsedProgram): the program the node belongs to.
    """

    __slots__ = ("_node", "program", "_children", "_named")

    def __init__(self, node: TSNodeLike, program: ParsedProgram) -> None:
        self._node = node
        self.program = program
        self._children: list[ProgramNode] | None = None
        self._named: list[ProgramNode] | None = None

    def __getattr__(self, name: str) -> Any:
        self.program.check()
        return getattr(self._node, name)

    def _wrap(self, node: TSNodeLike | None) -> "ProgramNode | None":
        return None if node is None else ProgramNode(node, self.program)

    @property
    def type(self) -> str:
        self.program.check()
        return self._node.type

    @property
    def text(self) -> bytes | None:
        self.program.check()
        return self._node.text

    @property
    def start_byte(self) -> int:
        self.program.check()
        return self._node.start_byte

    @property
    def end_byte(self) -> int:
        self.program.check()
        return self._node.end_byte

    @property
    def is_named(self) -> bool:
        self.program.check()
        return self._node.is_named

    @property
    def is_missing(self) -> bool:
        self.program.check()
        return self._node.is_missing

    @property
    def has_error(self) -> bool:
        self.program.check()
        return self._node.has_error

    @property
    def children(self) -> list["ProgramNode"]:
        self.program.check()
        if self._children is None:
            self._children = [
                ProgramNode(node, self.program) for node in self._node.children
            ]
        return list(self._children)

    @property
    def named_children(self) -> list["ProgramNode"]:
        self.program.check()
        if self._named is None:
            self._named = [
                ProgramNode(node, self.program)
                for node in self._node.named_children
            ]
        return list(self._named)

    @property
    def parent(self) -> "ProgramNode | None":
        self.program.check()
        return self._wrap(self._node.parent)

    @property
    def next_sibling(self) -> "ProgramNode | None":
        self.program.check()
        return self._wrap(self._node.next_sibling)

    @property
    def prev_sibling(self) -> "ProgramNode | None":
        self.program.check()
        return self._wrap(self._node.prev_sibling)

    def child(self, index: int) -> "ProgramNode | None":
        children = self.children
        return children[index] if 0 <= index < len(children) else None

    def child_by_field_name(self, name: str) -> "ProgramNode | None":
        self.program.check()
        return self._wrap(self._node.child_by_field_name(name))


def retain_programs(nodes: Sequence[TSNodeLike]) -> Callable[[], None]:
    """Retain each program the nodes come from, once; return the release.

    Args:
        nodes (Sequence[TSNodeLike]): nodes, or synthetic wrappers holding
            them, that must outlive their defining line.
    """
    programs: set[ParsedProgram] = set()
    pending = list(nodes)
    while pending:
        node = pending.pop()
        if isinstance(node, ProgramNode):
            programs.add(node.program)
        else:
            pending.extend(getattr(node, "children", ()))
    leases = [program.retain() for program in programs]

    def release() -> None:
        for lease in leases:
            lease()

    return release

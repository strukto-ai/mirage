from bisect import bisect_left
from collections.abc import Callable, Sequence
from typing import Any
from weakref import WeakSet

from mirage._rs import ShellNode
from mirage.shell.bytes import encode_text
from mirage.shell.types import TSNodeLike


class ParsedProgram:
    """One parse of a line: its tree, where each of its bytes sits in the
    line as typed, and the references that keep it.

    The final explicit release clears the tree and maps, even if stale
    node wrappers remain reachable.

    Args:
        original (str): the line as typed.
        root (ShellNode): the parsed tree.
    """

    def __init__(self, original: str, root: ShellNode) -> None:
        self.original = original
        self.offsets: Sequence[int] = root.offsets
        self._nodes: WeakSet[ProgramNode] = WeakSet()
        self.references = 1
        self._released = False
        self._newlines: list[int] | None = None
        self._root: ProgramNode | None = ProgramNode(root, self)

    @property
    def root(self) -> "ProgramNode":
        self.check()
        assert self._root is not None
        return self._root

    def row(self, offset: int) -> int:
        """The row a byte of the line as typed is on: the newlines before
        it, found once per parse.

        Args:
            offset (int): the byte's offset in the line as typed.
        """
        self.check()
        if self._newlines is None:
            text = encode_text(self.original)
            found = []
            at = text.find(b"\n")
            while at != -1:
                found.append(at)
                at = text.find(b"\n", at + 1)
            self._newlines = found
        return bisect_left(self._newlines, offset)

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
                self._drop()

        return release

    def release(self) -> None:
        if not self._released:
            self._released = True
            self._drop()

    def _drop(self) -> None:
        self.references -= 1
        if self.references == 0:
            for node in self._nodes:
                node._borrowed = None
                node._children = None
                node._named = None
            self._nodes.clear()
            self.original = ""
            self.offsets = ()
            self._newlines = None
            self._root = None


class ProgramNode:
    """A node of a parsed program; every read checks the program is held.

    The wrappers of a node's children are built once and kept, so a walk
    pays for each wrapper one time, and the attributes walks read most go
    straight to the node.

    Args:
        node (TSNodeLike): the node it reads.
        program (ParsedProgram): the program the node belongs to.
    """

    __slots__ = ("_borrowed", "program", "_children", "_named", "__weakref__")

    def __init__(self, node: TSNodeLike, program: ParsedProgram) -> None:
        self._borrowed: TSNodeLike | None = node
        program._nodes.add(self)
        self.program = program
        self._children: list[ProgramNode] | None = None
        self._named: list[ProgramNode] | None = None

    @property
    def _node(self) -> TSNodeLike:
        self.program.check()
        assert self._borrowed is not None
        return self._borrowed

    def __getattr__(self, name: str) -> Any:
        self.program.check()
        return getattr(self._node, name)

    def _wrap(self, node: TSNodeLike | None) -> "ProgramNode | None":
        return None if node is None else ProgramNode(node, self.program)

    @property
    def offsets(self) -> Sequence[int]:
        self.program.check()
        return self.program.offsets

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


def shell_node(node: TSNodeLike) -> ShellNode | None:
    """The parser's own node a node reads, None for a synthetic one.

    Args:
        node (TSNodeLike): a program's node, the parser's, or a literal.
    """
    if isinstance(node, ProgramNode):
        return shell_node(node._node)
    return node if isinstance(node, ShellNode) else None


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

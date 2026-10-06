from collections.abc import Callable, Sequence
from typing import Any

from mirage.shell.parse.types import SyntaxDiagnostic
from mirage.shell.types import TSNodeLike


class ParsedProgram:
    def __init__(
        self,
        original: str,
        root: TSNodeLike,
        offsets: tuple[int, ...],
        diagnostics: tuple[SyntaxDiagnostic, ...] = (),
    ) -> None:
        self.diagnostics = diagnostics
        self.original = original
        self.normalized = root.text or b""
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
    def __init__(self, node: TSNodeLike, program: ParsedProgram) -> None:
        self._node = node
        self.program = program

    def __getattr__(self, name: str) -> Any:
        self.program.check()
        return getattr(self._node, name)

    def _wrap(self, node: TSNodeLike | None) -> "ProgramNode | None":
        return None if node is None else ProgramNode(node, self.program)

    @property
    def children(self) -> list["ProgramNode"]:
        self.program.check()
        return [
            ProgramNode(node, self.program) for node in self._node.children
        ]

    @property
    def named_children(self) -> list["ProgramNode"]:
        self.program.check()
        return [
            ProgramNode(node, self.program)
            for node in self._node.named_children
        ]

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
        self.program.check()
        children = self._node.children
        return (
            self._wrap(children[index]) if 0 <= index < len(children) else None
        )

    def child_by_field_name(self, name: str) -> "ProgramNode | None":
        self.program.check()
        return self._wrap(self._node.child_by_field_name(name))


def retain_programs(nodes: Sequence[TSNodeLike]) -> Callable[[], None]:
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

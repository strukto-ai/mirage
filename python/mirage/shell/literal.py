from dataclasses import dataclass, field
from shlex import join

from mirage.shell.types import TSNodeLike


@dataclass
class LiteralNode:
    type: str
    text: bytes
    children: list[TSNodeLike] = field(default_factory=list)
    start_byte: int = 0
    parent: TSNodeLike | None = None
    prev_sibling: TSNodeLike | None = None
    next_sibling: TSNodeLike | None = None
    is_named: bool = True
    is_missing: bool = False
    has_error: bool = False

    @property
    def id(self) -> int:
        return id(self)

    @property
    def named_children(self) -> list[TSNodeLike]:
        return self.children

    @property
    def child_count(self) -> int:
        return len(self.children)

    @property
    def end_byte(self) -> int:
        return self.start_byte + len(self.text)

    @property
    def start_point(self) -> tuple[int, int]:
        return (0, self.start_byte)

    @property
    def end_point(self) -> tuple[int, int]:
        return (0, self.end_byte)

    def child_by_field_name(self, name: str) -> TSNodeLike | None:
        return self.children[0] if name == "name" and self.children else None


def literal_tree(argv: tuple[str, ...]) -> TSNodeLike:
    """Build literal words without parsing or evaluating argv contents.

    Args:
        argv (tuple[str, ...]): a nonempty executable and its arguments.
    """
    if not argv or not argv[0] or any("\0" in arg for arg in argv):
        raise ValueError("argv must name a program and contain no NUL bytes")
    words: list[LiteralNode] = []
    offset = 0
    for i, arg in enumerate(argv):
        word = LiteralNode("raw_string", ("'" + arg + "'").encode(),
                           start_byte=offset)
        if i == 0:
            name = LiteralNode("command_name", arg.encode(), [word])
            word.parent = name
            words.append(name)
        else:
            words.append(word)
        offset += len(word.text) + 1
    text = join(argv).encode()
    command = LiteralNode("command", text, list(words))
    for part in words:
        part.parent = command
    program = LiteralNode("program", text, [command])
    command.parent = program
    return program

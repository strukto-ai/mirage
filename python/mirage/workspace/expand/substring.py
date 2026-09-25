from collections.abc import AsyncIterator, Awaitable, Callable, Iterator

from mirage.shell.escapes import unescape_unquoted
from mirage.shell.helpers import get_text
from mirage.shell.types import TSNodeLike


def _atoms(node: TSNodeLike) -> Iterator[TSNodeLike]:
    if node.type == "concatenation":
        for child in node.children:
            yield from _atoms(child)
    elif node.is_named and node.type not in ("word", "number"):
        yield node


def _separator(data: bytes, start: int, end: int, atoms: list[TSNodeLike],
               base: int) -> int:
    opaque = {atom.start_byte - base: atom.end_byte - base for atom in atoms}
    depth = 0
    ternary = 0
    index = start
    while index < end:
        if index in opaque:
            index = opaque[index]
            continue
        byte = data[index]
        if byte == ord("\\"):
            index += 2
            continue
        if byte in b"([":
            depth += 1
        elif byte in b")]":
            depth -= 1
        elif depth == 0:
            if byte == ord("?"):
                ternary += 1
            elif byte == ord(":"):
                if ternary == 0:
                    return index
                ternary -= 1
        index += 1
    return end


async def substring_operands(
    node: TSNodeLike,
    expand_child: Callable[[TSNodeLike], Awaitable[str]],
) -> AsyncIterator[str]:
    """Split offset and length before expanding their nested words.

    The separator belongs to source syntax, never to substituted text.
    Colons inside quotes, substitutions, parentheses, subscripts and ternary
    expressions cannot split the operands. Both scalar and array slicing use
    this path. Each operand expands only when requested, so the caller can
    evaluate and apply the offset before requesting the length.

    Args:
        node (TSNodeLike): substring expansion parsed with word operands.
        expand_child (Callable): evaluator for nested words.
    """
    operator = next(c for c in node.children if get_text(c) == ":")
    children = [
        c for c in node.children
        if c.start_byte >= operator.end_byte and c.type != "}"
    ]
    atoms = [atom for child in children for atom in _atoms(child)]
    data = node.text or b""
    start = operator.end_byte - node.start_byte
    end = len(data) - 1
    separator = _separator(data, start, end, atoms, node.start_byte)
    spans = [(start, separator)]
    if separator < end:
        spans.append((separator + 1, end))
    for begin, stop in spans:
        pieces = []
        cursor = begin
        for atom in atoms:
            left = atom.start_byte - node.start_byte
            right = atom.end_byte - node.start_byte
            if begin <= left and right <= stop:
                pieces.append(unescape_unquoted(data[cursor:left].decode()))
                pieces.append(await expand_child(atom))
                cursor = right
        pieces.append(unescape_unquoted(data[cursor:stop].decode()))
        yield "".join(pieces)

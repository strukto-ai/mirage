from mirage.shell.parse.heredoc.line import construct_end
from mirage.shell.types import TSNodeLike


def expansion_source(data: bytes, root: TSNodeLike) -> bytes:
    """Parse substring operands as words, leaving arithmetic to evaluation.

    GNU Bash 5.2 accepts even malformed arithmetic in a balanced substring
    expansion until that word runs. tree-sitter instead requires arithmetic
    syntax here and even rejects valid dollar references. A same-width
    default operator gives its word parser ownership of the operand. The
    caller restores the original source with verified tree reuse, so all
    consumers still read the colon and original offsets. No operand text is
    erased, and nested substitutions remain visible to policy and execution.

    Args:
        data (bytes): shell source.
        root (TSNodeLike): the original parse, including recovery tokens.
    """
    if b"${" not in data:
        return data
    out = bytearray(data)
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        children = node.children
        for index, child in enumerate(children):
            if child.type != "${":
                continue
            tail = list(children[index + 1:])
            if tail and tail[0].type == "!":
                tail.pop(0)
            if (len(tail) < 2 or tail[0].type
                    not in ("variable_name", "special_variable_name",
                            "subscript") or tail[1].type != ":"):
                continue
            if construct_end(data, child.start_byte, ord("}")) is not None:
                out[tail[1].start_byte] = ord("-")
    return bytes(out)

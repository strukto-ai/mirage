from mirage.shell.bytes import decode_text
from mirage.shell.parameter import bad_substitution
from mirage.shell.parse.heredoc.line import construct_end
from mirage.shell.parse.names import walk_tree
from mirage.shell.types import TSNodeLike


def expansion_source(data: bytes, root: TSNodeLike) -> bytes:
    """Spell parameter expansions the way the grammar can read them.

    GNU Bash 5.2 judges a ``${...}`` only when the word holding it runs.
    A substring operand may be malformed arithmetic until then, where
    tree-sitter requires arithmetic syntax and even rejects valid dollar
    references, so a same-width default operator gives its word parser
    ownership of the operand. A ``${...}`` bash refuses outright
    (``bad_substitution``) becomes one name of the same width, so the line
    parses and the expansion fails where bash's does. The caller reads the
    tree against the original source, so all consumers still read the
    source as written, and nested substitutions of an expansion that
    stands remain visible to policy and execution.

    Args:
        data (bytes): shell source.
        root (TSNodeLike): the original parse, including recovery tokens.
    """
    if b"${" not in data:
        return data
    opens: list[tuple[TSNodeLike, list[TSNodeLike]]] = []
    for node in walk_tree(root):
        children = node.children
        opens.extend(
            (child, list(children[index + 1 :]))
            for index, child in enumerate(children)
            if child.type == "${"
        )
    out = bytearray(data)
    covered = 0
    for child, tail in sorted(opens, key=lambda pair: pair[0].end_byte):
        start = child.end_byte - 2
        end = construct_end(data, start, ord("}"))
        if start < covered or end is None:
            continue
        if bad_substitution(decode_text(data[start:end])):
            out[start + 2 : end - 1] = b"a" * (end - start - 3)
            covered = end
            continue
        if tail and tail[0].type == "!":
            tail.pop(0)
        if (
            len(tail) >= 2
            and tail[0].type
            in ("variable_name", "special_variable_name", "subscript")
            and tail[1].type == ":"
        ):
            out[tail[1].start_byte] = ord("-")
    return bytes(out)

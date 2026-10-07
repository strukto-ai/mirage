from collections.abc import Callable, Sequence

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse.syntax import (
    find_syntax_issue,
    find_unterminated_backtick,
    syntax_error_message,
)
from mirage.shell.parse.types import SourceSpan, SyntaxDiagnostic, SyntaxIssue
from mirage.shell.types import TSNodeLike


def diagnose(
    root: TSNodeLike,
    offsets: Sequence[int],
    parse_fn: Callable[[str], TSNodeLike] | None = None,
    aliases: frozenset[str] = frozenset(),
) -> tuple[SyntaxDiagnostic, ...]:
    """The line's syntax errors, each span mapped back into the line.

    Args:
        root (TSNodeLike): the parsed line.
        offsets (Sequence[int]): ``source_offsets`` of that parse.
        parse_fn (Callable[[str], TSNodeLike] | None): parses a ``$(...)``
            body so its own syntax is judged.
        aliases (frozenset[str]): alias names the shell would expand.
    """
    found = find_syntax_issue(root, aliases, parse_fn=parse_fn)
    unclosed = find_unterminated_backtick(decode_text(root.text or b""))
    if found is None and unclosed is not None:
        found = SyntaxIssue(
            unclosed,
            SourceSpan(
                root.end_byte - len(encode_text(unclosed)), root.end_byte
            ),
        )
    if found is None:
        return ()
    start, end = found.span.start, found.span.end
    return (
        SyntaxDiagnostic(
            found.offending,
            SourceSpan(
                offsets[start] if start < len(offsets) else start,
                offsets[end] if end < len(offsets) else end,
            ),
            syntax_error_message(found.offending, root),
        ),
    )

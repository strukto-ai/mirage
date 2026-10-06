from collections.abc import Callable, Sequence

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse.syntax import (
    find_syntax_issue,
    find_unterminated_backtick,
    find_unterminated_quote,
)
from mirage.shell.parse.types import SourceSpan, SyntaxDiagnostic, SyntaxIssue
from mirage.shell.types import TSNodeLike


def diagnose(
    root: TSNodeLike,
    offsets: Sequence[int],
    parse_fn: Callable[[str], TSNodeLike] | None = None,
    aliases: frozenset[str] = frozenset(),
) -> tuple[SyntaxDiagnostic, ...]:
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
    quote = find_unterminated_quote(root)
    snippet = found.offending.strip()
    message = (
        f"mirage: unexpected EOF while looking for matching `{quote}'\n"
        if quote is not None
        else f"mirage: syntax error near '{snippet}'\n"
        if snippet
        else "mirage: syntax error in command\n"
    )
    start, end = found.span.start, found.span.end
    return (
        SyntaxDiagnostic(
            found.offending,
            SourceSpan(
                offsets[start] if start < len(offsets) else start,
                offsets[end] if end < len(offsets) else end,
            ),
            message,
        ),
    )

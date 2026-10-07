from collections.abc import Sequence

from mirage.shell.parse.syntax import check_syntax, find_syntax_issue
from mirage.shell.parse.types import SourceSpan, SyntaxDiagnostic
from mirage.shell.types import TSNodeLike


def diagnose(
    command: str,
    root: TSNodeLike,
    offsets: Sequence[int],
    aliases: frozenset[str] = frozenset(),
) -> tuple[SyntaxDiagnostic, ...]:
    """The line's syntax errors, each span in the line as typed.

    Args:
        command (str): the line.
        root (TSNodeLike): its parse, for an error only the grammar finds.
        offsets (Sequence[int]): ``source_offsets`` of that parse.
        aliases (frozenset[str]): alias names the shell would expand.
    """
    found = check_syntax(command, aliases)
    if found is not None:
        return (found,)
    issue = find_syntax_issue(root)
    if issue is None:
        return ()
    start, end = issue.span.start, issue.span.end
    return (
        SyntaxDiagnostic(
            issue.offending,
            SourceSpan(
                offsets[start] if start < len(offsets) else start,
                offsets[end] if end < len(offsets) else end,
            ),
            issue.message,
            issue.status,
        ),
    )

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from mirage.policy.types import Occurrence
from mirage.shell.types import FunctionBody, TSNodeLike


def function_sources(value: Mapping[str, Any]) -> dict[str, str]:
    """Copy portable function definitions without parsing or executing them.

    Args:
        value (Mapping[str, Any]): stored function names and shell source.
    """
    if not isinstance(value, Mapping) or any(
        not isinstance(name, str) or not isinstance(source, str)
        for name, source in value.items()
    ):
        raise ValueError("functions must map names to shell source strings")
    return dict(value)


@dataclass(frozen=True, slots=True)
class FunctionSite:
    """Where a function was defined, for the source it was defined as.

    The body is parsed again from that source at every call, so its own
    rows and offsets start at zero; the site puts them back where the
    definition stood. A site whose source no longer matches the table (a
    checkout, a stored session) is not the function's.

    Args:
        source (str): the definition the site was recorded for.
        mark (tuple[int, int]): the parse and row the body reads aliases
            at, as an alias mark.
        origin (Occurrence | None): the definition's place on its line,
            which the body's approvals stand under; None outside a line.
        aliases (Mapping[str, str] | None): the aliases the body runs,
            as its definition saw them (``alias_view``); None to read
            them as they are when it runs.
        name (str): what the body's diagnostics name as their source:
            the file it was sourced from, else ``environment``.
        row (int): the row the definition starts on as its text was
            typed, which the body's ``$LINENO`` counts from.
        lines (tuple[tuple[int, int] | None, ...] | None): for a
            definition inside a body bash prints again (``$( )``), the
            line each node of the body is numbered by and ends on, in
            order, from the definition's own (``site_lines``); None for
            the rows as typed.
    """

    source: str
    mark: tuple[int, int]
    origin: Occurrence | None
    aliases: Mapping[str, str] | None = None
    name: str = "environment"
    row: int = 0
    lines: tuple[tuple[int, int] | None, ...] | None = None


def _preorder(body: FunctionBody) -> list[TSNodeLike]:
    """A body's nodes, each before its children, in order.

    Args:
        body (FunctionBody): the body's statements.
    """
    out: list[TSNodeLike] = []
    stack = list(reversed(body))
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(reversed(node.children))
    return out


def site_lines(
    rows: Mapping[int, tuple[int, int]] | None, base: int, body: FunctionBody
) -> tuple[tuple[int, int] | None, ...] | None:
    """The lines a definition's body is numbered by in a body bash prints
    again, each from ``base``, the definition's own: a call parses the
    body again from its text, whose rows bash does not count there
    (``f(){ echo $LINENO; }`` in ``$( )`` prints over several lines).
    None outside such a body.

    Args:
        rows (Mapping[int, tuple[int, int]] | None): the running body's
            lines by node id (``reread_lines``), None for rows as typed.
        base (int): the definition's line.
        body (FunctionBody): the definition's body statements.
    """
    if rows is None:
        return None
    return tuple(
        None
        if (found := rows.get(node.id)) is None
        else (found[0] - base, found[1] - base)
        for node in _preorder(body)
    )


def called_lines(
    lines: Sequence[tuple[int, int] | None] | None, body: FunctionBody
) -> dict[int, tuple[int, int]] | None:
    """``site_lines`` laid over a call's own parse of the body, by node id;
    None when there are none, or the call's parse is shaped otherwise (an
    alias the body expands now).

    Args:
        lines (Sequence[tuple[int, int] | None] | None): the site's lines.
        body (FunctionBody): the call's body statements.
    """
    nodes = _preorder(body)
    if lines is None or len(nodes) != len(lines):
        return None
    return {
        node.id: line
        for node, line in zip(nodes, lines, strict=True)
        if line is not None
    }

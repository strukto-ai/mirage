from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from mirage.policy.types import Occurrence


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
    """

    source: str
    mark: tuple[int, int]
    origin: Occurrence | None
    aliases: Mapping[str, str] | None = None

from collections.abc import Mapping
from typing import Any


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

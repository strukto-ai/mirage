import math

from mirage.vfs.types import SearchQuery


def validate_options(query: SearchQuery, allowed: set[str]) -> None:
    unknown = set(query.options) - allowed
    if unknown:
        raise ValueError(
            f"search: unknown options: {', '.join(sorted(unknown))}"
        )


def int_option(query: SearchQuery, key: str, default: int) -> int:
    value = query.options.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"search: {key} must be an integer")
    return value


def float_option(query: SearchQuery, key: str, default: float) -> float:
    value = query.options.get(key, default)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"search: {key} must be a finite number")
    return float(value)


def text_option(query: SearchQuery, key: str, default: str) -> str:
    value = query.options.get(key, default)
    if not isinstance(value, str):
        raise ValueError(f"search: {key} must be a string")
    return value

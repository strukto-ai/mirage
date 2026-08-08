import re
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.size_suffix import size_suffixes
from mirage.commands.errors import UsageError
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec

# GNU truncate's letter set differs from split's and od's: lowercase
# g/k/m/t are accepted, b is not (pinned against coreutils 9.7).
_UNITS = size_suffixes("EGKMPQRTYZgkmt")
_OFF_T_MAX = 2**63 - 1
_WS = " \t\n\v\f\r"
_TRY_HELP = "\nTry 'truncate --help' for more information."

# GNU reads the -s operand as [ws][mode][ws][sign]digits[suffix]: C-locale
# whitespace is skipped before and after the mode character (` < 4` caps at
# 4), while the digits must follow the sign immediately, so `1x`, `+ 4`,
# `++4` and `1_0` are all `Invalid number` rather than a silently truncated
# read (pinned against coreutils 9.7).
_DIGITS = re.compile(r"[0-9]+")


def parse_size(value: str, current: int) -> int:
    """Resolve a GNU ``truncate -s`` spec against a file's current size.

    Args:
        value (str): the ``-s`` operand, e.g. ``10K``, ``+1M``, ``/512``.
        current (int): the file's current size in bytes.
    """
    stripped = value.lstrip(_WS)
    operation = stripped[:1] if stripped[:1] in {"<", ">", "/", "%"} else ""
    remainder = stripped[1:].lstrip(_WS) if operation else stripped
    sign = remainder[:1] if remainder[:1] in {"+", "-"} else ""
    if sign and operation:
        # A sign after <, >, / or % is a second relative modifier, refused
        # before the number is read (`<+4` is not an invalid number).
        raise UsageError(
            "truncate: multiple relative modifiers specified" + _TRY_HELP, 1)
    raw = remainder[1:] if sign else remainder
    suffix = next((unit for unit in sorted(_UNITS, key=len, reverse=True)
                   if raw.endswith(unit)), "")
    digits = raw[:-len(suffix)] if suffix else raw
    # GNU quotes what xdectoimax saw: the remainder past the skipped
    # whitespace and mode character, sign included (`<abc` says 'abc').
    if _DIGITS.fullmatch(digits) is None:
        raise UsageError(f"truncate: Invalid number: '{remainder}'", 1)
    number = int(digits) * _UNITS.get(suffix, 1)
    # off_t is signed, so the bound is 2**63 - 1 upward but 2**63 downward
    # (`-s -8E` reduces to zero while `-s 8E` is too large).
    if number > _OFF_T_MAX + (1 if sign == "-" else 0):
        raise UsageError(
            f"truncate: Invalid number: '{remainder}': "
            "Value too large for defined data type", 1)
    if number == 0 and operation in {"/", "%"}:
        raise UsageError("truncate: division by zero", 1)
    if sign == "+":
        return current + number
    if sign == "-":
        return max(0, current - number)
    if operation == "<":
        return min(current, number)
    if operation == ">":
        return max(current, number)
    if operation == "/":
        return current - current % number
    if operation == "%":
        return ((current + number - 1) // number) * number
    return number


async def truncate(
    paths: list[PathSpec],
    *,
    size: str,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    truncate_fn: Callable[[PathSpec, int], Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("truncate: missing file operand")
    for path in paths:
        current = (await stat(path)).size or 0
        await truncate_fn(path, parse_size(size, current))
    return None, IOResult()


__all__ = ["parse_size", "truncate"]

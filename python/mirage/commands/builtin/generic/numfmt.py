import re
from decimal import Decimal, InvalidOperation

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult

_SI_SUFFIXES = ("", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q")


def _parse_number(value: str, from_mode: str) -> Decimal:
    match = re.fullmatch(r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-z]*)", value)
    if match is None:
        raise InvalidOperation(value)
    number = Decimal(match.group(1))
    suffix = match.group(2)
    if not suffix or from_mode == "none":
        return number
    normalized = suffix.removesuffix("i").removesuffix("B")
    if normalized not in _SI_SUFFIXES:
        raise InvalidOperation(value)
    exponent = _SI_SUFFIXES.index(normalized)
    base = 1000 if from_mode == "si" else 1024
    return number * (Decimal(base)**exponent)


def _format_number(number: Decimal, to_mode: str, grouping: bool) -> str:
    suffix = ""
    if to_mode != "none":
        base = Decimal(1000 if to_mode == "si" else 1024)
        exponent = 0
        while abs(number) >= base and exponent < len(_SI_SUFFIXES) - 1:
            number /= base
            exponent += 1
        suffix = _SI_SUFFIXES[exponent]
        if to_mode == "iec-i" and exponent:
            suffix += "i"
    rounded = number.quantize(
        Decimal("1")) if number == number.to_integral() else number.quantize(
            Decimal("0.1"))
    text = format(rounded, ",f" if grouping else "f")
    return text + suffix


async def numfmt(
    *texts: str,
    stdin: ByteSource | None = None,
    to_mode: str = "none",
    from_mode: str = "none",
    suffix: str = "",
    grouping: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    values = list(texts)
    if not values:
        raw = await _read_stdin_async(stdin)
        values = raw.decode(
            errors="replace").split() if raw is not None else []
    output = [
        _format_number(_parse_number(value.removesuffix(suffix), from_mode),
                       to_mode, grouping) + suffix for value in values
    ]
    return ("\n".join(output) + "\n").encode(), IOResult()


__all__ = ["numfmt"]

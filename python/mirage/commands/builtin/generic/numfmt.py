import re
from decimal import Decimal, InvalidOperation

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult

_SI_SUFFIXES = ("", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q")
_FIRST_FIELD_RE = re.compile(r"(\s*)(\S+)([\s\S]*)")


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


def _convert_field(value: str, to_mode: str, from_mode: str, suffix: str,
                   grouping: bool) -> str:
    number = _parse_number(value.removesuffix(suffix), from_mode)
    return _format_number(number, to_mode, grouping) + suffix


def _convert_line(line: str, to_mode: str, from_mode: str, suffix: str,
                  grouping: bool) -> str:
    """Reformat the first field of a record, preserving the rest verbatim.

    GNU ``numfmt`` converts only ``--field`` (1 by default) and copies the
    remaining fields and their separating whitespace through untouched.

    Args:
        line (str): One input record, without its terminator.
        to_mode (str): Output scaling mode.
        from_mode (str): Input scaling mode.
        suffix (str): Suffix stripped before parsing and re-appended.
        grouping (bool): Whether to group thousands in the output.
    """
    match = _FIRST_FIELD_RE.fullmatch(line)
    if match is None:
        return line
    lead, field, rest = match.groups()
    return lead + _convert_field(field, to_mode, from_mode, suffix,
                                 grouping) + rest


async def numfmt(
    *texts: str,
    stdin: ByteSource | None = None,
    to_mode: str = "none",
    from_mode: str = "none",
    suffix: str = "",
    grouping: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if texts:
        output = [
            _convert_field(value, to_mode, from_mode, suffix, grouping)
            for value in texts
        ]
    else:
        raw = await _read_stdin_async(stdin)
        data = raw.decode(errors="replace") if raw is not None else ""
        output = [
            _convert_line(line, to_mode, from_mode, suffix, grouping)
            for line in split_lines(data)
        ]
    if not output:
        return b"", IOResult()
    return ("\n".join(output) + "\n").encode(), IOResult()


__all__ = ["numfmt"]

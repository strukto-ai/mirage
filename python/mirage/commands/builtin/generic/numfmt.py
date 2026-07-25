import re
from decimal import ROUND_HALF_EVEN, ROUND_UP, Decimal, InvalidOperation

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult

_SUFFIX_ORDER = ("", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q")
# SI spells kilo lowercase; every larger unit and all of IEC stay uppercase.
_SI_DISPLAY = ("", "k", *_SUFFIX_ORDER[2:])
_FIRST_FIELD_RE = re.compile(r"(\s*)(\S+)([\s\S]*)")


def _parse_number(value: str, from_mode: str) -> Decimal:
    match = re.fullmatch(r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))([A-Za-z]*)", value)
    if match is None:
        raise InvalidOperation(value)
    number = Decimal(match.group(1))
    suffix = match.group(2)
    if not suffix or from_mode == "none":
        return number
    normalized = suffix.removesuffix("i").removesuffix("B").upper()
    if normalized not in _SUFFIX_ORDER:
        raise InvalidOperation(value)
    exponent = _SUFFIX_ORDER.index(normalized)
    base = 1000 if from_mode == "si" else 1024
    return number * (Decimal(base)**exponent)


def _format_number(number: Decimal, to_mode: str, grouping: bool) -> str:
    """Render a value the way GNU numfmt does for the given --to mode.

    GNU rounds away from zero, keeping one decimal only while the scaled
    value is below 10. That rounding can push a value back over the base
    (999.4 -> 1000 -> 1.0k), so the unit is re-checked afterwards. The final
    render goes through printf, which rounds half-even, which is why an
    unscaled 2.5 prints as 2.

    Args:
        number (Decimal): Value to render, already --from scaled.
        to_mode (str): One of ``none``, ``si``, ``iec`` or ``iec-i``.
        grouping (bool): Whether to group thousands.
    """
    if to_mode == "none":
        return format(number.normalize(), ",f" if grouping else "f")
    base = Decimal(1000 if to_mode == "si" else 1024)
    display = _SI_DISPLAY if to_mode == "si" else _SUFFIX_ORDER
    power = 0
    while abs(number) >= base and power < len(display) - 1:
        number /= base
        power += 1
    step = Decimal("0.1") if abs(number) < 10 else Decimal(1)
    number = number.quantize(step, rounding=ROUND_UP)
    if abs(number) >= base and power < len(display) - 1:
        number /= base
        power += 1
    places = 1 if power and abs(number) < 10 else 0
    number = number.quantize(Decimal(1).scaleb(-places),
                             rounding=ROUND_HALF_EVEN)
    suffix = display[power]
    if to_mode == "iec-i" and power:
        suffix += "i"
    spec = f",.{places}f" if grouping else f".{places}f"
    return format(number, spec) + suffix


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

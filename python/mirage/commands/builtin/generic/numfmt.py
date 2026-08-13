import re
from decimal import ROUND_HALF_EVEN, ROUND_UP, Context, Decimal

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.errors import UsageError
from mirage.io.types import ByteSource, IOResult

_SUFFIX_ORDER = ("", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q")
# SI spells kilo lowercase; every larger unit and all of IEC stay uppercase.
_SI_DISPLAY = ("", "k", *_SUFFIX_ORDER[2:])
_FIRST_FIELD_RE = re.compile(r"(\s*)(\S+)([\s\S]*)")
# GNU accepts no leading '+' and no bare trailing '.', and it reads no
# exponent: `1e3` is a number followed by the unknown suffix 'e3'.
_NUMBER_RE = re.compile(r"(-?(?:[0-9]*\.[0-9]+|[0-9]+))(.*)", re.DOTALL)
# Only kilo has a lowercase spelling; every larger unit is uppercase-only.
_UNIT_EXPONENTS = {
    "K": 1,
    "k": 1,
    **{
        u: i
        for i, u in enumerate(_SUFFIX_ORDER) if i >= 2
    },
}


def _context_for(text: str) -> Context:
    """A decimal context wide enough to hold this field exactly.

    A field's significant digits can never exceed its own length and the
    largest ``--from`` multiplier (1024**10) adds 31 more, so the string
    length plus a fixed margin is a safe and cheap upper bound. The default
    28-digit context is not: it rounds ``1024**10`` on the way in, and
    quantizing a thirty-digit result under it raises InvalidOperation
    instead of printing ``numfmt --from=si 1Q``.

    Args:
        text (str): the input field, as typed.
    """
    return Context(prec=len(text) + 64, rounding=ROUND_UP)


def _suffix_error(value: str, junk: str) -> UsageError:
    """GNU's two shapes of suffix complaint, exit 2 either way.

    An unusable first character quotes only the whole field; a usable unit
    followed by junk quotes the field and then the junk (pinned against
    coreutils 9.7).

    Args:
        value (str): the whole input field, as typed.
        junk (str): the unusable tail, or "" for the whole-field shape.
    """
    if not junk:
        return UsageError(f"numfmt: invalid suffix in input: '{value}'", 2)
    return UsageError(f"numfmt: invalid suffix in input '{value}': '{junk}'",
                      2)


def _scale_of(value: str, suffix: str, from_mode: str) -> tuple[int, int]:
    """Read a unit suffix as a (base, exponent) pair for ``--from``.

    Each mode spells the same units differently: si and iec take the bare
    letter, iec-i requires the trailing 'i', and auto takes either and lets
    the 'i' pick base 1024. Nothing may follow (pinned against coreutils
    9.7), which is why `1KiB` is refused everywhere -- it used to be read
    as a kilobyte in both languages.

    Args:
        value (str): the whole input field, for the error messages.
        suffix (str): everything after the digits; never empty.
        from_mode (str): one of ``si``, ``iec``, ``iec-i`` or ``auto``.
    """
    exponent = _UNIT_EXPONENTS.get(suffix[0])
    if exponent is None:
        raise _suffix_error(value, "")
    tail = suffix[1:]
    if from_mode == "iec-i":
        if not tail:
            raise UsageError(
                f"numfmt: missing 'i' suffix in input: '{value}' "
                "(e.g Ki/Mi/Gi)", 2)
        if tail[0] != "i":
            raise _suffix_error(value, tail)
        if tail[1:]:
            raise _suffix_error(value, tail[1:])
        return 1024, exponent
    if from_mode == "auto":
        base = 1024 if tail[:1] == "i" else 1000
        rest = tail[1:] if base == 1024 else tail
        if rest:
            raise _suffix_error(value, rest)
        return base, exponent
    if tail:
        raise _suffix_error(value, tail)
    return (1000 if from_mode == "si" else 1024), exponent


def _parse_number(value: str, from_mode: str) -> tuple[Decimal, int]:
    """Read one input field as an exact value plus its --to=none precision.

    GNU prints an unscaled value back at the precision it was typed with
    (``1.000`` stays ``1.000``) and a scaled one as a whole number rounded
    away from zero (``1.0005K`` is ``1001``), so the decimal count travels
    with the value. A unit that is spelled correctly but unusable because
    no ``--from`` was given is reported as such, which is why the unit
    letter is checked before the mode is. Deliberate divergence: GNU calls
    a second decimal point an invalid suffix in some spellings and an
    invalid number in others (``1.5.5`` against ``1..5``); mirage calls
    every trailing decimal point an invalid number.

    Args:
        value (str): the whole input field, as typed.
        from_mode (str): one of ``none``, ``si``, ``iec``, ``iec-i``,
            ``auto``.
    """
    match = _NUMBER_RE.fullmatch(value)
    if match is None or (match.group(2).startswith(".")
                         and "." not in match.group(1)):
        raise UsageError(f"numfmt: invalid number: '{value}'", 2)
    digits, suffix = match.group(1), match.group(2)
    number = Decimal(digits)
    _, _, fraction = digits.partition(".")
    if not suffix:
        return number, len(fraction)
    if suffix[0] not in _UNIT_EXPONENTS:
        raise _suffix_error(value, "")
    if from_mode == "none":
        raise UsageError(
            f"numfmt: rejecting suffix in input: '{value}' "
            "(consider using --from)", 2)
    base, exponent = _scale_of(value, suffix, from_mode)
    ctx = _context_for(value)
    return ctx.multiply(number, ctx.power(Decimal(base), exponent)), 0


def _format_number(number: Decimal, to_mode: str, grouping: bool,
                   decimals: int) -> str:
    """Render a value the way GNU numfmt does for the given --to mode.

    GNU rounds away from zero, keeping one decimal only while the scaled
    value is below 10. That rounding can push a value back over the base
    (999.4 -> 1000 -> 1.0k), so the unit is re-checked afterwards. The final
    render goes through printf, which rounds half-even, which is why an
    unscaled 2.5 prints as 2. --to=none instead keeps the precision the
    value was parsed with and rounds away from zero there, always in fixed
    notation -- ``1Y`` is a twenty-five digit number, never ``1e+24``.
    Deliberate divergence: GNU reads the input into a long double first, so
    a value it cannot hold exactly rounds up on the way out (``1.10`` prints
    as ``1.11`` while ``1.20`` and ``1.30`` do not); mirage keeps the value
    exact, as it already does for printf.

    Args:
        number (Decimal): Value to render, already --from scaled.
        to_mode (str): One of ``none``, ``si``, ``iec`` or ``iec-i``.
        grouping (bool): Whether to group thousands.
        decimals (int): Decimal places for ``--to=none``.
    """
    if to_mode == "none":
        number = number.quantize(Decimal(1).scaleb(-decimals),
                                 rounding=ROUND_UP,
                                 context=_context_for(str(number)))
        return format(number,
                      f",.{decimals}f" if grouping else f".{decimals}f")
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
    number, decimals = _parse_number(value.removesuffix(suffix), from_mode)
    return _format_number(number, to_mode, grouping, decimals) + suffix


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

# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import math
import re

from mirage.commands.builtin.constants import C_SPACE, INTMAX, UINTMAX
from mirage.commands.builtin.utils.strtod import (
    STRTOD,
    strtod_double,
    strtold_erange,
)
from mirage.commands.quote import quote_text
from mirage.shell.bytes import byte_char, encode_text
from mirage.shell.escapes import code_point_text

# C's int, which bounds a ``*`` width or precision.
_INT_MAX = (1 << 31) - 1
_INT_MIN = -(1 << 31)

# The integer strtoimax and strtoumax read at base 0 in the C locale: the
# blanks and sign, then hex after 0x, binary after 0b (glibc 2.38 on),
# octal after a leading 0, else decimal. A 0x or 0b with no digit after
# it reads as the 0 alone.
_STRTOL = re.compile(
    rf"{C_SPACE}([+-]?)(?:0[xX]([0-9a-fA-F]+)|0[bB]([01]+)|(0[0-7]*)|([1-9][0-9]*))"
)

_PRINTF_FLAGS = "-+ 0#"

_PRINTF_CONV = "sdiouxXeEfFgGaAcbq%"

# printf's escape grammar is not echo's: it reads a bare \NNN, while
# echo -e wants \0NNN and gives \c a different meaning. Only the simple
# table and \x, \u and \U overlap, and only printf warns when those
# three have no digits, so each reader keeps its own.
_SIMPLE_ESCAPES = {
    "\\": "\\",
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}

_HEX = set("0123456789abcdefABCDEF")

_OCT = set("01234567")

_ANSIC_ESCAPES = {
    "\x07": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    "\x1b": "\\E",
    "\\": "\\\\",
    "'": "\\'",
}

_Q_SAFE = set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%+-./:=@_"
)


def _read_int(text: str, signed: bool) -> tuple[int, int, bool]:
    """Read an integer argument as strtoimax (signed) or strtoumax does.

    Returns the value, how many characters were read (0 when no number
    starts the text) and whether it was out of range. A signed value
    stops at the 64-bit bounds and an unsigned one at 2**64 - 1, while a
    negative unsigned one in range wraps around 2**64.

    Args:
        text (str): the argument as typed.
        signed (bool): read for ``%d``/``%i`` rather than ``%o %u %x %X``.
    """
    found = _STRTOL.match(text)
    if found is None:
        return 0, 0, False
    sign, hexa, binary, octal, decimal = found.groups()
    if hexa is not None:
        n = int(hexa, 16)
    elif binary is not None:
        n = int(binary, 2)
    elif octal is not None:
        n = int(octal, 8)
    else:
        n = int(decimal) if len(decimal) <= 20 else UINTMAX + 1
    if signed:
        limit = INTMAX + (sign == "-")
        value = min(n, limit)
        return (-value if sign == "-" else value), found.end(), n > limit
    if n > UINTMAX:
        return UINTMAX, found.end(), True
    return (-n & UINTMAX if sign == "-" else n), found.end(), False


def _numeric_error(
    raw: str, read: int, erange: bool, program: bool, warnings: list[str]
) -> str | None:
    """The error a numeric argument fails printf with, or None.

    bash's builtin says ``invalid number`` for an argument it could not
    read whole, naming the base when the text opens as an octal (``0``
    and a digit) or hex (``0x``) number, and only warns when the value
    was out of range; an empty argument is a quiet 0. GNU's program
    refuses an empty or unread argument, a partly read one and an out of
    range one alike, quoting the argument. A warning that does not fail
    printf goes to ``warnings``.

    Args:
        raw (str): the argument as typed.
        read (int): how many characters the reader took.
        erange (bool): the value was out of range.
        program (bool): the coreutils program's voice, not the builtin's.
        warnings (list[str]): collects the warnings.
    """
    if program:
        if erange:
            problem = "Numerical result out of range"
        elif read == 0:
            problem = "expected a numeric value"
        elif read < len(raw):
            problem = "value not completely converted"
        else:
            return None
        return f"printf: '{quote_text(raw)}': {problem}\n"
    if read < len(raw):
        if re.match("0[0-9]", raw):
            base = "octal "
        elif raw.startswith("0x"):
            base = "hex "
        else:
            base = ""
        return f"printf: {raw}: invalid {base}number\n"
    if erange:
        warnings.append(
            f"printf: warning: {raw}: Numerical result out of range\n"
        )
    return None


def _character_value(
    raw: str, program: bool, posix: bool, warnings: list[str]
) -> tuple[int, str | None]:
    """The value of a leading-quote argument: its next character's code.

    bash's builtin takes a lone quote as 0. GNU's program refuses it, and
    warns that it ignored any characters after the first unless
    ``POSIXLY_CORRECT`` is in its environment.

    Args:
        raw (str): the argument, opening with ``'`` or ``"``.
        program (bool): the coreutils program's voice, not the builtin's.
        posix (bool): the program runs with ``POSIXLY_CORRECT`` set.
        warnings (list[str]): collects the warning.
    """
    rest = raw[1:]
    if not rest:
        if program:
            return (
                0,
                f"printf: '{quote_text(raw)}': expected a numeric value\n",
            )
        return 0, None
    if program and not posix and len(rest) > 1:
        warnings.append(
            f"printf: warning: {rest[1:]}: character(s) following character"
            " constant have been ignored\n"
        )
    return ord(rest[0]), None


def _int_argument(
    raw: str, signed: bool, program: bool, posix: bool, warnings: list[str]
) -> tuple[int, str | None]:
    """An integer argument's value and the error it fails printf with.

    Args:
        raw (str): the argument as typed.
        signed (bool): read for ``%d``/``%i`` (and a ``*`` width or
            precision) rather than ``%o %u %x %X``.
        program (bool): the coreutils program's voice, not the builtin's.
        posix (bool): the program runs with ``POSIXLY_CORRECT`` set.
        warnings (list[str]): collects the warnings.
    """
    if raw[:1] in ("'", '"'):
        return _character_value(raw, program, posix, warnings)
    value, read, erange = _read_int(raw, signed)
    return value, _numeric_error(raw, read, erange, program, warnings)


def _float_argument(
    raw: str, program: bool, posix: bool, warnings: list[str]
) -> tuple[float, str | None]:
    """A floating-point argument's value and the error it fails printf with.

    Args:
        raw (str): the argument as typed.
        program (bool): the coreutils program's voice, not the builtin's.
        posix (bool): the program runs with ``POSIXLY_CORRECT`` set.
        warnings (list[str]): collects the warnings.
    """
    if raw[:1] in ("'", '"'):
        code, err = _character_value(raw, program, posix, warnings)
        return float(code), err
    found = STRTOD.match(raw)
    if found is None:
        return 0.0, _numeric_error(raw, 0, False, program, warnings)
    return strtod_double(found), _numeric_error(
        raw, found.end(), strtold_erange(found), program, warnings
    )


def _star_value(
    star: str,
    precision: bool,
    following: str | None,
    program: bool,
    posix: bool,
    warnings: list[str],
) -> tuple[int, str | None, bool]:
    """A ``*`` width or precision, held to C's ``int``.

    GNU's program refuses one outside it and stops, except a precision
    under it, which reads as omitted. bash's builtin holds it at the
    bound and warns, naming the argument after the ``*``.

    Args:
        star (str): the ``*`` argument as typed.
        precision (bool): it is a precision rather than a width.
        following (str | None): the argument after it, if any.
        program (bool): the coreutils program's voice, not the builtin's.
        posix (bool): the program runs with ``POSIXLY_CORRECT`` set.
        warnings (list[str]): collects the warnings.

    Returns:
        tuple[int, str | None, bool]: the value, the error that fails
            printf, and whether that error stops it.
    """
    value, err = _int_argument(star, True, program, posix, warnings)
    if _INT_MIN <= value <= _INT_MAX:
        return value, err, False
    if program:
        if precision and value < 0:
            return value, err, False
        if err is not None:
            warnings.append(err)
        field = "precision" if precision else "field width"
        return value, f"printf: invalid {field}: '{quote_text(star)}'\n", True
    if following is not None:
        warnings.append(
            f"printf: warning: {following}: Numerical result out of range\n"
        )
    return max(_INT_MIN, min(value, _INT_MAX)), err, False


def _apply_pad(
    prefix: str, body: str, flags: str, width: int | None, allow_zero: bool
) -> str:
    """Pad ``prefix + body`` to ``width`` per the justify/zero flags.

    Args:
        prefix (str): sign or base prefix kept ahead of any zero-fill.
        body (str): the digits or text being padded.
        flags (str): active conversion flags.
        width (int | None): minimum field width.
        allow_zero (bool): whether the ``0`` flag may zero-fill here.
    """
    s = prefix + body
    if width is None or len(s) >= width:
        return s
    pad = width - len(s)
    if "-" in flags:
        return s + " " * pad
    if allow_zero and "0" in flags:
        return prefix + "0" * pad + body
    return " " * pad + s


def _format_int(
    value: int, conv: str, flags: str, width: int | None, precision: int | None
) -> str:
    """Render ``%d %i %o %u %x %X`` with GNU flag rules.

    Args:
        value (int): the value as read, signed for ``%d``/``%i`` and
            unsigned for the rest.
        conv (str): the conversion character.
        flags (str): active flags.
        width (int | None): minimum field width.
        precision (int | None): minimum digit count.
    """
    prefix = ""
    if conv in ("d", "i"):
        neg = value < 0
        digits = str(-value if neg else value)
        if neg:
            prefix = "-"
        elif "+" in flags:
            prefix = "+"
        elif " " in flags:
            prefix = " "
    elif conv == "o":
        digits = format(value, "o")
    elif conv in ("x", "X"):
        digits = format(value, "x")
    else:
        digits = format(value, "d")
    if precision is not None:
        if precision == 0 and all(c == "0" for c in digits):
            digits = ""
        elif len(digits) < precision:
            digits = digits.rjust(precision, "0")
    nonzero = any(c != "0" for c in digits)
    if "#" in flags:
        if conv == "x" and nonzero:
            prefix = "0x"
        elif conv == "X" and nonzero:
            prefix = "0X"
        elif conv == "o" and not digits.startswith("0"):
            digits = "0" + digits
    if conv == "X":
        digits = digits.upper()
    allow_zero = "0" in flags and precision is None
    return _apply_pad(prefix, digits, flags, width, allow_zero)


def _format_float(
    value: float,
    conv: str,
    flags: str,
    width: int | None,
    precision: int | None,
) -> str:
    """Render ``%f %F %e %E %g %G`` via the platform C formatter.

    Args:
        value (float): the parsed value.
        conv (str): the conversion character.
        flags (str): active flags.
        width (int | None): minimum field width.
        precision (int | None): precision.
    """
    spec = "%" + flags
    if width is not None:
        spec += str(width)
    if precision is not None:
        spec += "." + str(precision)
    spec += conv
    return spec % value


def _format_hex_float(
    value: float,
    flags: str,
    width: int | None,
    precision: int | None,
    upper: bool,
) -> str:
    """Render ``%a``/``%A`` at IEEE double precision (py/ts identical;
    differs from bash, which formats in ``long double``).

    Args:
        value (float): the parsed value.
        flags (str): active flags.
        width (int | None): minimum field width.
        precision (int | None): hex-digit precision.
        upper (bool): uppercase (``%A``) form.
    """
    sign = (
        "-"
        if math.copysign(1.0, value) < 0
        else ("+" if "+" in flags else (" " if " " in flags else ""))
    )
    if not math.isfinite(value):
        body = "nan" if math.isnan(value) else "inf"
        sign = "" if body == "nan" else sign
        body = body.upper() if upper else body
        return _apply_pad(sign, body, flags, width, False)
    mant, exp = math.frexp(abs(value))
    if abs(value) == 0.0:
        lead, frac_hex, exp2 = 0, "", 0
    else:
        # frexp gives mant in [0.5, 1); shift to [1, 2) with leading 1.
        lead = 1
        exp2 = exp - 1
        frac = mant * 2 - 1
        frac_hex = ""
        for _ in range(13):
            frac *= 16
            d = int(frac)
            frac_hex += "0123456789abcdef"[d]
            frac -= d
    if precision is not None:
        frac_hex = _round_hex(frac_hex, precision)
    else:
        frac_hex = frac_hex.rstrip("0")
    prefix = sign + ("0X" if upper else "0x")
    body = str(lead)
    if frac_hex or ("#" in flags):
        body += "." + frac_hex
    exp_sign = "+" if exp2 >= 0 else "-"
    body += ("P" if upper else "p") + exp_sign + str(abs(exp2))
    if upper:
        body = body.upper()
    allow_zero = "0" in flags
    return _apply_pad(prefix, body, flags, width, allow_zero)


def _round_hex(frac_hex: str, precision: int) -> str:
    if precision >= len(frac_hex):
        return frac_hex.ljust(precision, "0")
    if not precision:
        return ""
    kept = frac_hex[:precision]
    nd = int(frac_hex[precision], 16)
    round_up = nd > 8 or (
        nd == 8
        and (
            int(frac_hex[precision + 1 :] or "0", 16) > 0
            or int(kept[-1], 16) % 2 == 1
        )
    )
    rounded = format(int(kept, 16) + round_up, "x")
    return rounded.rjust(precision, "0")[-precision:]


def _expand_escapes(s: str, warnings: list[str]) -> tuple[str, bool]:
    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == "\\":
            text, i, stop = _read_escape(s, i, warnings, b_arg=True)
            out.append(text)
            if stop:
                return "".join(out), True
        else:
            out.append(s[i])
            i += 1
    return "".join(out), False


def _quote_shell(s: str) -> str:
    if s == "":
        return "''"
    data = encode_text(s)
    need_ansic = any(b < 0x20 or b == 0x7F or b >= 0x80 for b in data)
    if need_ansic:
        parts = ["$'"]
        for b in data:
            ch = chr(b)
            if ch in _ANSIC_ESCAPES:
                parts.append(_ANSIC_ESCAPES[ch])
            elif 0x20 <= b < 0x7F:
                parts.append(ch)
            else:
                parts.append("\\" + format(b, "03o"))
        parts.append("'")
        return "".join(parts)
    out: list[str] = []
    for i, ch in enumerate(s):
        if ch in _Q_SAFE or (ch in "#~" and i != 0):
            out.append(ch)
        else:
            out.append("\\" + ch)
    return "".join(out)


def _read_escape(
    fmt: str, i: int, warnings: list[str], b_arg: bool
) -> tuple[str, int, bool]:
    """Interpret a backslash escape at ``fmt[i]``. Returns the emitted
    text, the next index, and whether output should stop (``\\c``).

    An octal escape in the format is ``\\NNN``, one to three digits. A
    ``%b`` argument also takes ``\\0NNN``: after a leading ``0``, up to
    three more digits. bash 5.2.37 writes ``printf '\\0003'`` as NUL
    then ``3`` and ``printf %b '\\0003'`` as the byte 3.

    A ``\\x``, ``\\u`` or ``\\U`` with no hex digit after it is written
    as it stands, and bash's warning for it goes to ``warnings``. bash
    writes it as a ``bash: printf:`` diagnostic and leaves the exit status
    alone, so ``printf '\\x'`` still exits 0.

    Args:
        fmt (str): the format string, or a ``%b`` argument.
        i (int): index of the backslash.
        warnings (list[str]): collects the warnings, in the order bash
            writes them to stderr.
        b_arg (bool): whether ``fmt`` is a ``%b`` argument.
    """
    n = len(fmt)
    if i + 1 >= n:
        return "\\", i + 1, False
    ch = fmt[i + 1]
    if ch == "c":
        return "", i + 2, True
    if ch in _SIMPLE_ESCAPES:
        return _SIMPLE_ESCAPES[ch], i + 2, False
    if ch in ("x", "u", "U"):
        limit = 2 if ch == "x" else (4 if ch == "u" else 8)
        digits: list[str] = []
        j = i + 2
        while j < n and len(digits) < limit and fmt[j] in _HEX:
            digits.append(fmt[j])
            j += 1
        if digits:
            value = int("".join(digits), 16)
            # \x names a byte; \u and \U name a code point.
            text = byte_char(value) if ch == "x" else code_point_text(value)
            return text, j, False
        kind = "hex" if ch == "x" else "unicode"
        warnings.append(f"printf: missing {kind} digit for \\{ch}\n")
        return "\\" + ch, i + 2, False
    if ch in _OCT:
        start = i + 1
        limit = 4 if b_arg and ch == "0" else 3
        j = start
        while j < n and j - start < limit and fmt[j] in _OCT:
            j += 1
        return byte_char(int(fmt[start:j], 8)), j, False
    return "\\" + ch, i + 2, False


def _read_conversion(
    fmt: str,
    i: int,
) -> tuple[str, int | str | None, int | str | None, str, int] | None:
    """Parse a conversion spec at ``fmt[i]`` (a ``%``). Returns
    ``(flags, width, precision, conv, next_index)``; width/precision may
    be an int, ``"*"`` (read from an argument), or ``None``. Returns
    ``None`` for anything unrecognized.

    Args:
        fmt (str): the format string.
        i (int): index of the percent sign.
    """
    n = len(fmt)
    j = i + 1
    if j < n and fmt[j] == "%":
        return "", None, None, "%", j + 1
    flags = ""
    while j < n and fmt[j] in _PRINTF_FLAGS:
        flags += fmt[j]
        j += 1
    width: int | str | None = None
    if j < n and fmt[j] == "*":
        width = "*"
        j += 1
    else:
        ws = j
        while j < n and fmt[j].isdigit():
            j += 1
        if j > ws:
            width = int(fmt[ws:j])
    precision: int | str | None = None
    if j < n and fmt[j] == ".":
        j += 1
        if j < n and fmt[j] == "*":
            precision = "*"
            j += 1
        else:
            ps = j
            while j < n and fmt[j].isdigit():
                j += 1
            precision = int(fmt[ps:j]) if j > ps else 0
    if j < n and fmt[j] in _PRINTF_CONV:
        return flags, width, precision, fmt[j], j + 1
    return None


def run_printf(
    fmt: str, args: list[str], program: bool = False, posix: bool = False
) -> tuple[str, list[str], bool, str | None]:
    """Apply GNU printf's format-reuse semantics: scan ``fmt`` once per
    cycle, consuming arguments; repeat while arguments remain and a cycle
    consumed at least one (so a conversion-less format prints once and
    excess args are dropped). Returns the output, the stderr messages in
    the order bash writes them, whether a conversion failed, and the
    first argument dropped, which coreutils printf names in a warning
    (None when every argument was used or ``\\c`` ended the output). An
    invalid number fails (exit status 1); a missing-digit escape warning
    does not.

    A ``\\c`` in a ``%b`` argument returns at once and reports no
    failure. bash's ``%b`` returns there with the status it has so far,
    and only the end of the builtin folds an invalid number into it, so
    bash 5.2.37 exits 0 for ``printf '%d%b' abc '\\c'``. coreutils 9.7's
    program stops there with status 0 as well, an earlier numeric error
    or not (``env printf '%f%b' 1e99999 '\\c'``).

    Args:
        fmt (str): the format string.
        args (list[str]): remaining positional arguments.
        program (bool): word numeric errors as the coreutils program
            does rather than as bash's builtin.
        posix (bool): the program runs with ``POSIXLY_CORRECT`` set.
    """
    out: list[str] = []
    messages: list[str] = []
    failed = False
    arg_i = 0
    total = len(args)
    stop = False
    while True:
        consumed_start = arg_i
        i = 0
        n = len(fmt)
        while i < n and not stop:
            ch = fmt[i]
            if ch == "\\":
                text, i, stop = _read_escape(fmt, i, messages, b_arg=False)
                out.append(text)
                continue
            if ch == "%":
                spec = _read_conversion(fmt, i)
                if spec is None:
                    out.append("%")
                    i += 1
                    continue
                flags, width, precision, conv, i = spec
                if conv == "%":
                    out.append("%")
                    continue
                for prec in (False, True):
                    if (precision if prec else width) != "*":
                        continue
                    star = args[arg_i] if arg_i < total else "0"
                    if arg_i < total:
                        arg_i += 1
                    following = args[arg_i] if arg_i < total else None
                    value, err, fatal = _star_value(
                        star, prec, following, program, posix, messages
                    )
                    if err is not None:
                        messages.append(err)
                        failed = True
                    if fatal:
                        return "".join(out), messages, True, None
                    if prec:
                        precision = None if value < 0 else value
                    elif value < 0:
                        flags += "-"
                        width = -value
                    else:
                        width = value
                raw = args[arg_i] if arg_i < total else None
                if raw is not None:
                    arg_i += 1
                w = width if isinstance(width, int) else None
                p = precision if isinstance(precision, int) else None
                text, err, stop = _convert(
                    conv, raw, flags, w, p, program, posix, messages
                )
                if err is not None:
                    messages.append(err)
                    failed = True
                out.append(text)
                if stop:
                    return "".join(out), messages, False, None
                continue
            out.append(ch)
            i += 1
        if stop or arg_i >= total or arg_i == consumed_start:
            break
    excess = args[arg_i] if not stop and arg_i < total else None
    return "".join(out), messages, failed, excess


def _convert(
    conv: str,
    raw: str | None,
    flags: str,
    width: int | None,
    precision: int | None,
    program: bool,
    posix: bool,
    warnings: list[str],
) -> tuple[str, str | None, bool]:
    """Render one conversion. Returns (text, error message or None, stop),
    where ``stop`` requests that all further output be suppressed (a
    ``\\c`` inside a ``%b`` argument).

    Args:
        conv (str): the conversion character.
        raw (str | None): the argument, or None when exhausted.
        flags (str): active flags.
        width (int | None): resolved field width.
        precision (int | None): resolved precision.
        program (bool): word numeric errors as the coreutils program
            does rather than as bash's builtin.
        posix (bool): the program runs with ``POSIXLY_CORRECT`` set.
        warnings (list[str]): collects the escape warnings of a ``%b``
            argument and the numeric warnings.
    """
    if conv in "sbcq":
        text, stop = raw or "", False
        if conv == "b":
            text, stop = _expand_escapes(text, warnings)
        elif conv == "q":
            text = _quote_shell(text)
        elif conv == "c":
            text = text[:1] or "\0"
        if precision is not None and conv in "sb":
            text = text[:precision]
        return _apply_pad("", text, flags, width, False), None, stop
    if conv in ("d", "i", "o", "u", "x", "X"):
        value, err = (
            (0, None)
            if raw is None
            else _int_argument(
                raw, conv in ("d", "i"), program, posix, warnings
            )
        )
        return _format_int(value, conv, flags, width, precision), err, False
    value_f, err = (
        (0.0, None)
        if raw is None
        else _float_argument(raw, program, posix, warnings)
    )
    if conv in ("a", "A"):
        return (
            _format_hex_float(value_f, flags, width, precision, conv == "A"),
            err,
            False,
        )
    return _format_float(value_f, conv, flags, width, precision), err, False

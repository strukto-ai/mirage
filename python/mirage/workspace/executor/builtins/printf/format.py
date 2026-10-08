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

from mirage.shell.bytes import byte_char, encode_text
from mirage.shell.escapes import code_point_text

_PRINTF_INT = re.compile(r"[+-]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)")

_PRINTF_FLAGS = "-+ 0#"

_PRINTF_CONV = "sdiouxXeEfFgGaAcbq%"

_UINT64_MASK = 0xFFFFFFFFFFFFFFFF

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


def _wrap_signed(n: int) -> int:
    return ((n + (1 << 63)) & _UINT64_MASK) - (1 << 63)


def _parse_printf_int(value: str) -> tuple[int, bool]:
    """Parse a printf integer argument like C's ``strtol`` (base auto:
    ``0x`` hex, leading ``0`` octal, else decimal, optional sign). The
    leading valid numeric prefix is used; a trailing or wholly invalid
    tail makes the parse ``ok=False`` while still yielding a value.

    Args:
        value (str): the raw argument text.
    """
    s = value.strip()
    if not s:
        return 0, True
    m = _PRINTF_INT.match(s)
    if not m:
        return 0, False
    tok = m.group(0)
    ok = tok == s
    sign = -1 if tok.startswith("-") else 1
    digits = tok.lstrip("+-")
    if digits[:2] in ("0x", "0X"):
        n = int(digits[2:], 16)
    elif len(digits) > 1 and digits[0] == "0":
        n = int(digits, 8)
    else:
        n = int(digits)
    return sign * n, ok


def _numeric_value(value: str) -> tuple[int, bool]:
    """Resolve a numeric argument, honoring the GNU leading-quote form
    (``"A`` / ``'A`` yields the code point of the next character).

    Args:
        value (str): the raw argument text.
    """
    if value[:1] in ("'", '"'):
        rest = value[1:]
        return (ord(rest[0]) if rest else 0), True
    return _parse_printf_int(value)


def _parse_float_arg(value: str) -> tuple[float, bool]:
    """Resolve a floating-point argument (decimal, hex float, inf/nan, or
    the leading-quote code-point form).

    Args:
        value (str): the raw argument text.
    """
    s = value.strip()
    if not s:
        return 0.0, True
    if s[0] in ("'", '"'):
        rest = s[1:]
        return (float(ord(rest[0])) if rest else 0.0), True
    try:
        if s.lower().lstrip("+-").startswith("0x"):
            return float.fromhex(s), True
        return float(s), True
    except ValueError:
        return 0.0, False


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
    """Render ``%d %i %o %u %x %X`` with 64-bit wrap and GNU flag rules.

    Args:
        value (int): the parsed value.
        conv (str): the conversion character.
        flags (str): active flags.
        width (int | None): minimum field width.
        precision (int | None): minimum digit count.
    """
    prefix = ""
    if conv in ("d", "i"):
        n = _wrap_signed(value)
        neg = n < 0
        digits = str(-n if neg else n)
        if neg:
            prefix = "-"
        elif "+" in flags:
            prefix = "+"
        elif " " in flags:
            prefix = " "
    else:
        u = value & _UINT64_MASK
        if conv == "o":
            digits = format(u, "o")
        elif conv in ("x", "X"):
            digits = format(u, "x")
        else:
            digits = format(u, "d")
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
    if value != value:
        body = "nan"
        return _apply_pad(
            "", body.upper() if upper else body, flags, width, False
        )
    if value in (float("inf"), float("-inf")):
        sign = (
            "-"
            if value < 0
            else ("+" if "+" in flags else (" " if " " in flags else ""))
        )
        body = "inf"
        return _apply_pad(
            sign, body.upper() if upper else body, flags, width, False
        )
    neg = math.copysign(1.0, value) < 0
    sign = (
        "-"
        if neg
        else ("+" if "+" in flags else (" " if " " in flags else ""))
    )
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
    kept = frac_hex[:precision]
    nxt = frac_hex[precision]
    val = int(kept, 16) if kept else 0
    nd = int(nxt, 16)
    round_up = nd > 8 or (
        nd == 8
        and (
            int(frac_hex[precision + 1 :] or "0", 16) > 0
            or (kept and int(kept[-1], 16) % 2 == 1)
        )
    )
    if round_up:
        val += 1
    result = format(val, "x").rjust(precision, "0") if precision else ""
    return result[-precision:] if precision else ""


def _format_printf_str(
    s: str, flags: str, width: int | None, precision: int | None
) -> str:
    """Render a string for ``%s`` with GNU printf width/precision rules.

    Args:
        s (str): the value.
        flags (str): active flags.
        width (int | None): minimum field width.
        precision (int | None): maximum character count.
    """
    if precision is not None:
        s = s[:precision]
    return _apply_pad("", s, flags, width, False)


def _format_char(value: str, flags: str, width: int | None) -> str:
    ch = value[0] if value else "\0"
    return _apply_pad("", ch, flags, width, False)


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
    fmt: str, args: list[str]
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
    bash 5.2.37 exits 0 for ``printf '%d%b' abc '\\c'``.

    Args:
        fmt (str): the format string.
        args (list[str]): remaining positional arguments.
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
                if width == "*":
                    star = args[arg_i] if arg_i < total else "0"
                    if arg_i < total:
                        arg_i += 1
                    wv, _ = _numeric_value(star)
                    if wv < 0:
                        flags += "-"
                        width = -wv
                    else:
                        width = wv
                if precision == "*":
                    star = args[arg_i] if arg_i < total else "0"
                    if arg_i < total:
                        arg_i += 1
                    pv, _ = _numeric_value(star)
                    precision = None if pv < 0 else pv
                raw = args[arg_i] if arg_i < total else None
                if raw is not None:
                    arg_i += 1
                w = width if isinstance(width, int) else None
                p = precision if isinstance(precision, int) else None
                text, err, stop = _convert(conv, raw, flags, w, p, messages)
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
        warnings (list[str]): collects the escape warnings of a ``%b``
            argument.
    """
    if conv == "s":
        return (
            _format_printf_str(raw or "", flags, width, precision),
            None,
            False,
        )
    if conv == "c":
        return _format_char(raw or "", flags, width), None, False
    if conv == "b":
        text, stop = _expand_escapes(raw or "", warnings)
        if precision is not None:
            text = text[:precision]
        return _apply_pad("", text, flags, width, False), None, stop
    if conv == "q":
        return (
            _apply_pad("", _quote_shell(raw or ""), flags, width, False),
            None,
            False,
        )
    if conv in ("d", "i", "o", "u", "x", "X"):
        if raw is None:
            value, err = 0, None
        else:
            value, valid = _numeric_value(raw)
            err = None if valid else f"printf: {raw}: invalid number\n"
        return _format_int(value, conv, flags, width, precision), err, False
    value_f, valid = (0.0, True) if raw is None else _parse_float_arg(raw)
    err = None if valid else f"printf: {raw}: invalid number\n"
    if conv in ("a", "A"):
        return (
            _format_hex_float(value_f, flags, width, precision, conv == "A"),
            err,
            False,
        )
    return _format_float(value_f, conv, flags, width, precision), err, False

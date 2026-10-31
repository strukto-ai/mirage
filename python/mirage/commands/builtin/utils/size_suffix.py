import sys


def parse_base0(digits: str) -> int:
    """The digits of a suffixed count operand, read at GNU's base 0.

    ``0x…`` is hex, a bare leading zero is octal, anything else decimal.
    Python's own ``int(s, 0)`` cannot stand in: it rejects ``010``,
    because python 3 dropped C's octal spelling.

    Args:
        digits (str): the digit run, sign and suffix already stripped.
    """
    if digits[:2].lower() == "0x":
        return int(digits, 16)
    if digits.startswith("0") and len(digits) > 1:
        return int(digits, 8)
    return decimal_value(digits)


def decimal_value(digits: str) -> int:
    """``digits`` read exactly as a decimal number, however long.

    CPython's ``int()`` refuses a decimal string longer than
    ``sys.get_int_max_str_digits()`` (4300 by default), and an option's
    digit run has no such bound, so the digits are read in runs that
    stay under it. Hex and octal are exempt from the limit.

    Args:
        digits (str): ASCII decimal digits, no sign.
    """
    run = sys.get_int_max_str_digits() or len(digits) or 1
    value = 0
    for start in range(0, len(digits), run):
        part = digits[start : start + run]
        value = value * 10 ** len(part) + int(part)
    return value


__all__ = ["decimal_value", "parse_base0"]

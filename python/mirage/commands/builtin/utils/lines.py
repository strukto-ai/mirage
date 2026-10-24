def record_separator(zero: bool) -> bytes:
    """The byte that ends a record: NUL under -z, else a newline.

    Args:
        zero (bool): whether the line asked for NUL-terminated records.
    """
    return b"\0" if zero else b"\n"


def split_lines(text: str, sep: str = "\n") -> list[str]:
    lines = text.split(sep)
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def split_lines_keepends(text: str) -> list[str]:
    out: list[str] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == "\n":
            out.append(text[start : i + 1])
            start = i + 1
    if start < len(text):
        out.append(text[start:])
    return out


__all__ = [
    "split_lines",
    "split_lines_keepends",
]

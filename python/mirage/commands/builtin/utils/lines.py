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


__all__ = ["split_lines"]

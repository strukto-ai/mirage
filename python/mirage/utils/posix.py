import re

# Character classes use the C locale in both runtimes.
POSIX_CLASSES = {
    "alpha": "A-Za-z",
    "digit": "0-9",
    "alnum": "0-9A-Za-z",
    "upper": "A-Z",
    "lower": "a-z",
    "space": " \\t\\n\\r\\f\\v",
    "blank": " \\t",
    "punct": "!-/:-@\\[-`{-~",
    "print": " -~",
    "graph": "!-~",
    "cntrl": "\\x00-\\x1f\\x7f",
    "xdigit": "0-9A-Fa-f",
}


def translate_bracket(pattern: str, start: int, out: list[str]) -> int:
    """Translate one bracket expression, expanding POSIX classes.

    Args:
        pattern (str): the whole ERE source.
        start (int): index of the opening ``[``.
        out (list[str]): accumulator receiving translated text.

    Returns:
        int: index just past the closing ``]``.
    """
    idx = start + 1
    out.append("[")
    if idx < len(pattern) and pattern[idx] == "^":
        out.append("^")
        idx += 1
    # A `]` in the first position is a literal member in an ERE, but
    # Python would read it as the end of the bracket expression.
    if idx < len(pattern) and pattern[idx] == "]":
        out.append("\\]")
        idx += 1
    while idx < len(pattern):
        ch = pattern[idx]
        if ch == "]":
            out.append("]")
            return idx + 1
        if pattern.startswith("[:", idx):
            close = pattern.find(":]", idx + 2)
            if close == -1:
                out.append("\\[")
                idx += 1
                continue
            name = pattern[idx + 2 : close]
            if name not in POSIX_CLASSES:
                raise re.error("Invalid character class name")
            out.append(POSIX_CLASSES[name])
            idx = close + 2
            continue
        if ch == "\\" and idx + 1 < len(pattern):
            out.append(pattern[idx : idx + 2])
            idx += 2
            continue
        if ch == "[":
            out.append("\\[")
            idx += 1
            continue
        out.append(ch)
        idx += 1
    raise re.error("Unmatched [, [^, [:, [., or [=")


def class_characters(name: str) -> str | None:
    """Expand a class to its ordered C-locale characters for tr.

    Args:
        name (str): a POSIX character class name.

    Returns:
        str | None: the class's characters, or None for no such class.
    """
    if name not in POSIX_CLASSES:
        return None
    pattern = re.compile("[" + POSIX_CLASSES[name] + "]")
    return "".join(chr(n) for n in range(128) if pattern.fullmatch(chr(n)))


def compile_posix_regex(source: str, flags: int = 0) -> re.Pattern[str]:
    """Compile translated POSIX regex source with C-locale case folding.

    Args:
        source (str): regex source in the host engine's syntax.
        flags (int): host regex flags, including IGNORECASE when requested.
    """
    return re.compile(source, flags | re.ASCII)

import re

# What each `.` and negated bracket checks first under a UTF-8 locale: a
# byte that is no part of a character rides the text as its surrogate
# escape, and glibc matches it with neither.
RAW_BYTE_GUARD = "(?![\\udc80-\\udcff])"

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


def bracket_end(source: str, start: int) -> int:
    """The index past the ``]`` closing the bracket opened at ``start``.

    Args:
        source (str): host regex source.
        start (int): index of the opening ``[``.
    """
    idx = start + 1
    if source.startswith("^", idx):
        idx += 1
    if source.startswith("]", idx):
        idx += 1
    while idx < len(source):
        if source[idx] == "\\":
            idx += 2
            continue
        if source[idx] == "]":
            return idx + 1
        idx += 1
    return len(source)


def skip_raw_bytes(source: str) -> str:
    """Keep `.` and a negated bracket off a byte that is no character.

    glibc's matcher in a UTF-8 locale reads an invalid byte as no
    character at all, so neither `.` nor `[^x]` matches it
    (``printf 'a\\377b\\n' | grep -c 'a.b'`` is 0). The text carries such
    a byte as its surrogate escape, which both would otherwise match; a
    lookahead before each keeps it out and leaves what `.` means for a
    newline to the flags.

    Args:
        source (str): host regex source.
    """
    out: list[str] = []
    idx = 0
    while idx < len(source):
        ch = source[idx]
        if ch == "\\":
            out.append(source[idx : idx + 2])
            idx += 2
        elif ch == "[":
            end = bracket_end(source, idx)
            bracket = source[idx:end]
            out.append(
                f"(?:{RAW_BYTE_GUARD}{bracket})"
                if bracket.startswith("[^")
                else bracket
            )
            idx = end
        else:
            out.append(f"(?:{RAW_BYTE_GUARD}.)" if ch == "." else ch)
            idx += 1
    return "".join(out)


def compile_posix_regex(
    source: str, flags: int = 0, utf8: bool = False
) -> re.Pattern[str]:
    """Compile translated POSIX regex source with C-locale case folding.

    Classes, word boundaries and case folding stay the C locale's ASCII
    ones under a UTF-8 locale too; what changes there is the subject,
    which is text, so `.` and a negated bracket match one character and
    never a byte that is no part of one.

    Args:
        source (str): regex source in the host engine's syntax.
        flags (int): host regex flags, including IGNORECASE when requested.
        utf8 (bool): the subject is text under a UTF-8 locale.
    """
    return re.compile(
        skip_raw_bytes(source) if utf8 else source, flags | re.ASCII
    )

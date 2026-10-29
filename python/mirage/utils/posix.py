import re

# What each `.` and negated bracket checks first under a UTF-8 locale: a
# byte that is no part of a character rides the text as its surrogate
# escape, and glibc matches it with neither.
RAW_BYTE_GUARD = "(?![\\udc80-\\udcff])"


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

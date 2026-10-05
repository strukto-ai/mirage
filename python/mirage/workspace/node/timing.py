import re

from mirage.shell.bytes import encode_text

DEFAULT_FORMAT = "\nreal\t%3lR\nuser\t%3lU\nsys\t%3lS"
TOKEN = re.compile(r"%(?:([0-9])?(l)?([RUS])|([%P]))")


def timing_report(
    elapsed: float, portable: bool, template: str | None
) -> bytes:
    """Format Bash elapsed time; CPU counters are unavailable per virtual job.

    User/system time is zero in both hosts, since browser runtimes cannot
    measure it and process-wide counters would include unrelated agents.

    Args:
        elapsed (float): monotonic elapsed seconds after draining the pipeline.
        portable (bool): -p uses POSIX's fixed format, ignoring TIMEFORMAT.
        template (str | None): session TIMEFORMAT, None selects Bash's default.
    """
    if portable:
        return encode_text(f"real {elapsed:.2f}\nuser 0.00\nsys 0.00\n")
    template = DEFAULT_FORMAT if template is None else template
    if not template:
        return b""
    pieces: list[str] = []
    cursor = 0
    for match in TOKEN.finditer(template):
        gap = template[cursor : match.start()]
        if "%" in gap:
            return b"mirage: TIMEFORMAT: invalid format character\n"
        pieces.append(gap)
        if match.group(4):
            pieces.append("%" if match.group(4) == "%" else "0.00")
        else:
            precision = min(int(match.group(1) or 3), 3)
            value = elapsed if match.group(3) == "R" else 0.0
            if match.group(2):
                minutes = int(value // 60)
                pieces.append(f"{minutes}m{value % 60:.{precision}f}s")
            else:
                pieces.append(f"{value:.{precision}f}")
        cursor = match.end()
    tail = template[cursor:]
    if "%" in tail:
        return b"mirage: TIMEFORMAT: invalid format character\n"
    return encode_text("".join(pieces) + tail + "\n")

from dataclasses import dataclass

from mirage.commands.builtin.grep_select import WalkFilters
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.constants import GREP_STDIN_LABEL


@dataclass(frozen=True, slots=True)
class GrepFlags:
    """Parsed grep flags (TS FlagSet parity); the complete set grep honors."""

    ignore_case: bool
    invert: bool
    line_numbers: bool
    byte_offsets: bool
    count_only: bool
    files_only: bool
    files_without_match: bool
    whole_word: bool
    line_regexp: bool
    fixed_string: bool
    syntax: RegexSyntax
    only_matching: bool
    quiet: bool
    no_messages: bool
    recursive: bool
    with_filename: bool
    no_filename: bool
    max_count: int | None
    after_context: int | None
    before_context: int | None
    binary_mode: str
    filters: WalkFilters
    skip_directories: bool = False
    skip_devices: bool = False
    null_data: bool = False
    null: bool = False
    initial_tab: bool = False
    group_separator: bytes | None = b"--"
    label: str = GREP_STDIN_LABEL
    dereference: bool = False


# GNU grep's INITIAL_BUFSIZE: the window it examines before printing from it.
PROBE_BLOCK_BYTES = 96 * 1024


def group_line(f: GrepFlags) -> bytes:
    """The line grep prints between two context groups, or nothing.

    GNU separates groups once -A, -B or -C is given, zero included and
    under -o too (grep 3.11: `grep -A0` prints `--` between two lines
    that are not neighbours); -c, -l, -L and -q print no lines.

    Args:
        f (GrepFlags): parsed flags.
    """
    if f.count_only or f.files_only or f.files_without_match or f.quiet:
        return b""
    if f.group_separator is None or (
        f.after_context is None and f.before_context is None
    ):
        return b""
    return f.group_separator + b"\n"


def name_end(f: GrepFlags) -> bytes:
    """What follows a file name -l or -L prints: NUL under -Z.

    Args:
        f (GrepFlags): parsed flags.
    """
    return b"\0" if f.null else b"\n"


def valid_utf8(data: bytes) -> bool:
    """Whether every byte of ``data`` belongs to a UTF-8 character.

    Args:
        data (bytes): the output to check.
    """
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True

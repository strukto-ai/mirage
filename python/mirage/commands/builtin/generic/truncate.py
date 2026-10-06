import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.paths import absent_dest_strerror
from mirage.commands.builtin.utils.size_suffix import size_suffixes
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, PathSpec
from mirage.utils.errors import (
    FS_ERRORS,
    eisdir,
    enoent,
    enotdir,
    fs_error_line,
)
from mirage.utils.stat_view import is_dir

# GNU truncate's letter set differs from split's and od's: lowercase
# g/k/m/t are accepted, b is not (pinned against coreutils 9.7).
_UNITS = size_suffixes("EGKMPQRTYZgkmt")
_OFF_T_MAX = 2**63 - 1
_WS = " \t\n\v\f\r"
_TRY_HELP = "\nTry 'truncate --help' for more information."

# GNU reads the -s operand as [ws][mode][ws][sign]digits[suffix]: C-locale
# whitespace is skipped before and after the mode character (` < 4` caps at
# 4), while the digits must follow the sign immediately, so `1x`, `+ 4`,
# `++4` and `1_0` are all `Invalid number` rather than a silently truncated
# read (pinned against coreutils 9.7).
_DIGITS = re.compile(r"[0-9]+")


def parse_size(value: str, current: int) -> int:
    """Resolve a GNU ``truncate -s`` spec against a file's current size.

    Args:
        value (str): the ``-s`` operand, e.g. ``10K``, ``+1M``, ``/512``.
        current (int): the file's current size in bytes.
    """
    stripped = value.lstrip(_WS)
    operation = stripped[:1] if stripped[:1] in {"<", ">", "/", "%"} else ""
    remainder = stripped[1:].lstrip(_WS) if operation else stripped
    sign = remainder[:1] if remainder[:1] in {"+", "-"} else ""
    if sign and operation:
        # A sign after <, >, / or % is a second relative modifier, refused
        # before the number is read (`<+4` is not an invalid number).
        raise UsageError(
            "truncate: multiple relative modifiers specified" + _TRY_HELP, 1
        )
    raw = remainder[1:] if sign else remainder
    suffix = next(
        (
            unit
            for unit in sorted(_UNITS, key=len, reverse=True)
            if raw.endswith(unit)
        ),
        "",
    )
    digits = raw[: -len(suffix)] if suffix else raw
    # GNU quotes what xdectoimax saw: the remainder past the skipped
    # whitespace and mode character, sign included (`<abc` says 'abc'),
    # escaped the way its quote() escapes a word.
    shown = quote_text(remainder)
    if _DIGITS.fullmatch(digits) is None:
        raise UsageError(f"truncate: Invalid number: '{shown}'", 1)
    number = int(digits) * _UNITS.get(suffix, 1)
    # off_t is signed, so the bound is 2**63 - 1 upward but 2**63 downward
    # (`-s -8E` reduces to zero while `-s 8E` is too large).
    if number > _OFF_T_MAX + (1 if sign == "-" else 0):
        raise UsageError(
            f"truncate: Invalid number: '{shown}': "
            "Value too large for defined data type",
            1,
        )
    if number == 0 and operation in {"/", "%"}:
        raise UsageError("truncate: division by zero", 1)
    if sign == "+":
        return current + number
    if sign == "-":
        return max(0, current - number)
    if operation == "<":
        return min(current, number)
    if operation == ">":
        return max(current, number)
    if operation == "/":
        return current - current % number
    if operation == "%":
        return ((current + number - 1) // number) * number
    return number


@dataclass(frozen=True, slots=True)
class TruncateFlags:
    """The truncate flag bag, parsed once.

    Args:
        size (str): the ``-s`` spec, as typed.
        no_create (bool): ``-c``; an absent name stays absent, silently.
    """

    size: str
    no_create: bool


def parse_flags(flags: Mapping[str, FlagValue]) -> TruncateFlags:
    """Parse the truncate flag bag once into a frozen struct.

    GNU reads the size while it reads the options, so a spec it refuses
    is refused here, before any operand is touched or named.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.
    """
    fl = FlagView(flags, spec=SPECS["truncate"])
    size = fl.as_str("size")
    if size is None:
        raise UsageError(
            "truncate: you must specify either '--size' or '--reference'"
            + _TRY_HELP,
            1,
        )
    parse_size(size, 0)
    return TruncateFlags(size=size, no_create=fl.as_bool("no_create"))


async def truncate_generic(
    paths: list[PathSpec],
    *,
    flags: TruncateFlags,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    truncate_fn: Callable[[PathSpec, int, bool], Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    """Set each operand's length, GNU ``truncate -s``.

    Every operand is tried, and one GNU cannot open is reported in its
    words and the rest still go (exit 1): ``cannot open 'x' for
    writing`` for any open failure, a directory's EISDIR included.

    Args:
        paths (list[PathSpec]): the file operands.
        flags (TruncateFlags): the parsed flags.
        stat (Callable): stats a path; raises when missing.
        truncate_fn (Callable): sets the length and enforces no_create.
    """
    if not paths:
        raise UsageError("truncate: missing file operand" + _TRY_HELP, 1)
    errors: list[str] = []
    for path in paths:
        try:
            await _truncate_one(path, flags, stat, truncate_fn)
        except FS_ERRORS as exc:
            errors.append(fs_error_line("truncate", path, exc))
    err = encode_text("".join(errors))
    return None, IOResult(exit_code=1 if err else 0, stderr=err or None)


async def _truncate_one(
    path: PathSpec,
    flags: TruncateFlags,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    truncate_fn: Callable[[PathSpec, int, bool], Awaitable[None]],
) -> None:
    """One operand, in the order GNU's open settles it.

    GNU opens the name before it looks at anything, with O_CREAT unless
    ``-c``: an absent file is made (``-c`` leaves it, silently), but only
    in a directory that exists, and a plain file in the chain is ENOTDIR
    either way. The size is read first here only because a relative
    spec needs it, so a stat that misses is not the verdict: the chain
    is, walked the way cp walks a destination's, since a backend's write
    would make a key under any parent at all. A directory, and a name
    typed with a slash in a directory that exists, is the open's EISDIR,
    settled here so a backend with no truncate op answers in GNU's words
    too: ``missing/`` and ``reg/`` are both ``Is a directory`` and nothing
    is made, while under ``-c`` ``reg/`` goes to the truncate op, whose
    lookup is ENOTDIR.

    Args:
        path (PathSpec): the operand.
        flags (TruncateFlags): the parsed flags.
        stat (Callable): stats a path; raises when missing.
        truncate_fn (Callable): sets the length and enforces no_create.
    """
    directory = False
    try:
        st = await stat(path)
        current = st.size or 0
        directory = is_dir(st)
    except (FileNotFoundError, NotADirectoryError) as exc:
        if isinstance(exc, NotADirectoryError) and (
            flags.no_create or not path.raw_path.endswith("/")
        ):
            raise
        why = await absent_dest_strerror(stat, path)
        if why == "Not a directory":
            raise enotdir(path) from exc
        if flags.no_create:
            return
        if why is not None:
            raise enoent(path) from exc
        current = 0
    if directory or (path.raw_path.endswith("/") and not flags.no_create):
        raise eisdir(path)
    await truncate_fn(path, parse_size(flags.size, current), flags.no_create)


__all__ = ["TruncateFlags", "parse_flags", "parse_size", "truncate_generic"]

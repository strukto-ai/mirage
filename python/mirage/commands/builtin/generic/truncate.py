from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal, cast, get_args

from mirage.commands.builtin.utils.paths import absent_dest_error
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import usage_hint
from mirage.errors.classify import classify
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.errors.posix import posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, PathSpec
from mirage.utils.path import ends_at_dot
from mirage.utils.quote import shell_quote_always
from mirage.utils.stat_view import is_dir

SizeMode = Literal[
    "absolute",
    "extend",
    "reduce",
    "at_most",
    "at_least",
    "round_down",
    "round_up",
]

MODES: frozenset[str] = frozenset(get_args(SizeMode))


@dataclass(frozen=True, slots=True)
class Size:
    """What ``-s`` asks of a file's size, as mirage-rs read it.

    Args:
        mode (SizeMode): how the number applies to the current size.
        number (int): the number typed, its suffix applied.
    """

    mode: SizeMode
    number: int


def resolve_size(size: Size, current: int) -> int:
    """The length ``size`` asks for, given a file's current one.

    Args:
        size (Size): the ``-s`` spec.
        current (int): the file's current size in bytes.
    """
    number = size.number
    if size.mode == "extend":
        return current + number
    if size.mode == "reduce":
        return max(0, current - number)
    if size.mode == "at_most":
        return min(current, number)
    if size.mode == "at_least":
        return max(current, number)
    if size.mode == "round_down":
        return current - current % number
    if size.mode == "round_up":
        return ((current + number - 1) // number) * number
    return number


@dataclass(frozen=True, slots=True)
class TruncateFlags:
    """The truncate flag bag, parsed once.

    Args:
        size (Size): the ``-s`` spec.
        no_create (bool): ``-c``; an absent name stays absent, silently.
    """

    size: Size
    no_create: bool


def parse_flags(flags: Mapping[str, FlagValue]) -> TruncateFlags | IOResult:
    """truncate's options, ``-s`` read by mirage-rs before any operand is
    resolved.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flag bag.

    Returns:
        TruncateFlags | IOResult: the flags, or truncate's refusal.
    """
    fl = FlagView(flags, spec=SPECS["truncate"])
    try:
        values = scan("truncate", fl.texts("size"))
    except StreamRefusal as refusal:
        return refused(refusal)
    size = values["size"]
    if not (
        isinstance(size, dict)
        and isinstance(mode := size.get("mode"), str)
        and mode in MODES
        and isinstance(number := size.get("size"), str)
    ):
        raise ValueError(f"truncate: mirage-rs read -s as {size!r}")
    return TruncateFlags(
        size=Size(mode=cast(SizeMode, mode), number=int(number)),
        no_create=fl.as_bool("no_create"),
    )


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
        raise UsageError(
            f"truncate: missing file operand\n{usage_hint('truncate')}", 1
        )
    errors: list[str] = []
    for path in paths:
        try:
            refused = await _truncate_one(path, flags, stat, truncate_fn)
        except FS_ERRORS as exc:
            errors.append(fs_error_line("truncate", path, exc))
        else:
            if refused is not None:
                errors.append(refused)
    err = encode_text("".join(errors))
    return None, IOResult(exit_code=1 if err else 0, stderr=err or None)


async def _truncate_one(
    path: PathSpec,
    flags: TruncateFlags,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    truncate_fn: Callable[[PathSpec, int, bool], Awaitable[None]],
) -> str | None:
    """One operand, in the order GNU's open settles it, and the line GNU
    prints when the open went through but the length did not take.

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
    lookup is ENOTDIR. A length that cannot take (a pipe has none) is
    the ftruncate step's EINVAL, which GNU words with the size it asked
    for: ``failed to truncate 'x' at 0 bytes: Invalid argument``.

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
        why = await absent_dest_error(stat, path)
        if why is FsCondition.ENOTDIR:
            raise enotdir(path) from exc
        if flags.no_create:
            return None
        if why is not None:
            raise enoent(path) from exc
        current = 0
    slashed = path.raw_path.endswith("/") and not ends_at_dot(path.raw_path)
    if directory or (slashed and not flags.no_create):
        raise eisdir(path)
    size = resolve_size(flags.size, current)
    try:
        await truncate_fn(path, size, flags.no_create)
    except OSError as exc:
        if classify(exc) is not FsCondition.EINVAL:
            raise
        label = shell_quote_always(path.raw_path or path.virtual)
        return (
            f"truncate: failed to truncate {label} at {size} bytes: "
            f"{posix_phrase(FsCondition.EINVAL)}\n"
        )
    return None


__all__ = [
    "Size",
    "TruncateFlags",
    "parse_flags",
    "resolve_size",
    "truncate_generic",
]

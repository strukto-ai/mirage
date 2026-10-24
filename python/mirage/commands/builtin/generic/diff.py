import re
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass, field
from datetime import datetime, timezone, tzinfo
from functools import partial

from mirage.commands.builtin.constants import INTMAX
from mirage.commands.builtin.utils.formatting import full_iso_time
from mirage.commands.builtin.utils.links import dispatch_of, links_of
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.builtin.utils.tree import before_full_walk
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
    usage_hint,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import format_fs_error
from mirage.errors.types import FsCondition
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.diff_pool import DiffPool
from mirage.rs.diff_types import DiffComputer, DiffOptions, PairResult
from mirage.rs.errors import StreamRefusal
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec, ReadStreamFn
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey
from mirage.utils.path import gnu_basename
from mirage.utils.quote import shell_quote
from mirage.utils.timezone import zone_from_env
from mirage.view.namespace_view import followed_stat
from mirage.view.types import LinkView, StatPath


@dataclass(frozen=True, slots=True)
class DiffFlags:
    ignore_case: bool = False
    ignore_all_space: bool = False
    ignore_space_change: bool = False
    ed: bool = False
    unified: bool = False
    context: int = 3
    brief: bool = False
    recursive: bool = False
    # -N reads a file missing on either side as empty, and
    # --unidirectional-new-file only one missing from the first.
    new_file: bool = False
    new_first: bool = False
    identical: bool = False
    exclude: tuple[str, ...] = ()
    exclude_from: tuple[PathSpec, ...] = ()


@dataclass(slots=True)
class _Walk:
    stream: ReadStreamFn
    readdir_fn: Callable[..., Awaitable[list[str]]]
    stat_fn: Callable[..., Awaitable[FileStat]]
    flags: DiffFlags
    excluded: tuple[str, ...]
    switches: str
    computer: DiffComputer
    stat_path: StatPath | None = None
    zone: tzinfo | None = None
    # An entry diff could not compare, reported as it goes on (exit 2).
    trouble: list[bytes] = field(default_factory=list)
    status: int = 0
    # The directory a path resolves to, where diff follows links.
    real: Callable[[str], str] | None = None


Absent = tuple[bool, bool]

PRESENT: Absent = (False, False)

# The characters GNU diff spells as a C escape in a header name. Any
# other control character is three octal digits.
HEADER_ESCAPES = {
    "\a": "a",
    "\b": "b",
    "\t": "t",
    "\n": "n",
    "\v": "v",
    "\f": "f",
    "\r": "r",
    '"': '"',
    "\\": "\\",
}


def _child_spec(parent: PathSpec, name: str) -> PathSpec:
    child = parent.virtual.rstrip("/") + "/" + name
    return PathSpec(
        virtual=child,
        directory=child,
        vfs_path=rekey(parent.virtual, parent.vfs_path, child),
        raw_path=_name(parent).rstrip("/") + "/" + name,
    )


def _name(path: PathSpec) -> str:
    return path.raw_path or path.virtual


def quote_header_name(name: str) -> str:
    """A file name as GNU diff writes it in a header line.

    GNU diff double-quotes a name holding a space, a double quote, a
    backslash or a control character, and writes each of those but the
    space as a C escape (``"sp ace"``, ``"t\\tab"``); any other name,
    bytes above ASCII included, is written as it is. The ``---`` and
    ``+++`` lines and the ``diff -r`` line use it; the ``Only in`` and
    ``Files ... differ`` lines do not.

    Args:
        name (str): the name as typed or walked.
    """
    if not any(ch == " " or ch in HEADER_ESCAPES or ch < " " for ch in name):
        return name
    out: list[str] = []
    for ch in name:
        if ch in HEADER_ESCAPES:
            out.append("\\" + HEADER_ESCAPES[ch])
        elif ch < " ":
            out.append(f"\\{ord(ch):03o}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


async def _header_time(walk: _Walk, path: PathSpec, absent: bool) -> str:
    """The time a unified header gives one side, as GNU diff prints it.

    The modification time as ``%Y-%m-%d %H:%M:%S.%N %z`` in the zone
    ``TZ`` names, read through the dispatcher as ``stat`` reads it, so
    a time ``touch`` keeps in the namespace shows; the epoch for a side
    -N reads as absent; and the present moment for standard input, as
    POSIX asks and diffutils does.

    Args:
        walk (_Walk): the reads and the parsed line.
        path (PathSpec): the side.
        absent (bool): whether -N reads it as absent.
    """
    if absent:
        return full_iso_time(None, walk.zone)
    if is_stdin(path):
        now = datetime.now(timezone.utc).isoformat()
        return full_iso_time(now, walk.zone)
    info = await walk.stat_path(path) if walk.stat_path is not None else None
    if info is None:
        info = await walk.stat_fn(path)
    return full_iso_time(info.modified, walk.zone)


def _takes_value(option: Argument) -> bool:
    return (
        option.action not in ("store_true", "count")
        and not option.nargs == "?"
    )


def switch_words(argv: Sequence[str]) -> list[str]:
    """The option words of a diff line, as GNU echoes them.

    GNU diff permutes its options in front of its operands and prints
    them, word for word and in order, on each ``diff -r`` header line:
    an option's detached value is its own word, ``--`` is kept, and
    every operand is left out.

    Args:
        argv (Sequence[str]): the words after ``diff``.
    """
    options = compile_spec(SPECS[CommandName.DIFF]).options
    shorts = {
        name[1:]: o
        for o in options
        for name in o.names
        if not name.startswith("--")
    }
    longs = {
        name[2:]: o
        for o in options
        for name in o.names
        if name.startswith("--")
    }
    words: list[str] = []
    i = 0
    while i < len(argv):
        word = argv[i]
        i += 1
        if word == "--":
            words.append(word)
            break
        if not word.startswith("-") or word == "-":
            continue
        words.append(word)
        if word.startswith("--"):
            name = word[2:].partition("=")[0]
            found = longs.get(name)
            matches = (
                [found]
                if found is not None
                else [o for n, o in longs.items() if n.startswith(name)]
            )
            if (
                "=" not in word
                and len(matches) == 1
                and _takes_value(matches[0])
                and i < len(argv)
            ):
                words.append(argv[i])
                i += 1
            continue
        for at, letter in enumerate(word[1:], 1):
            option = shorts.get(letter)
            if option is not None and _takes_value(option):
                if at == len(word) - 1 and i < len(argv):
                    words.append(argv[i])
                    i += 1
                break
    return words


async def _side(walk: _Walk, path: PathSpec, absent: bool) -> ByteSource:
    return b"" if absent else walk.stream(path)


async def _diff_pair(
    path1: PathSpec,
    path2: PathSpec,
    walk: _Walk,
    absent: Absent = PRESENT,
) -> PairResult:
    flags = walk.flags
    name1, name2 = _name(path1), _name(path2)
    options = DiffOptions(
        mode="ed" if flags.ed else "unified" if flags.unified else "normal",
        context=flags.context,
        ignore_case=flags.ignore_case,
        ignore_all_space=flags.ignore_all_space,
        ignore_space_change=flags.ignore_space_change,
        brief=flags.brief,
        old_label=name1,
        new_label=name2,
        old_header=(
            quote_header_name(name1)
            + "\t"
            + await _header_time(walk, path1, absent[0])
        )
        if flags.unified
        else "",
        new_header=(
            quote_header_name(name2)
            + "\t"
            + await _header_time(walk, path2, absent[1])
        )
        if flags.unified
        else "",
    )
    result = await walk.computer.compare(
        options,
        partial(_side, walk, path1, absent[0]),
        partial(_side, walk, path2, absent[1]),
    )
    if result.outcome == "different" and flags.brief and result.status == 1:
        return PairResult(
            result.outcome,
            (f"Files {name1} and {name2} differ\n".encode(),),
            result.status,
            result.stderr,
        )
    if result.outcome == "equal" and flags.identical and result.status == 0:
        return PairResult(
            result.outcome,
            (f"Files {name1} and {name2} are identical\n".encode(),),
            result.status,
            result.stderr,
        )
    return result


async def _entries(walk: _Walk, path: PathSpec, absent: bool) -> set[str]:
    if absent:
        return set()
    names = {gnu_basename(entry) for entry in await walk.readdir_fn(path)}
    return {
        name
        for name in names
        if not any(fnmatch(name, pattern) for pattern in walk.excluded)
    }


async def _entry_kind(walk: _Walk, path: PathSpec) -> FileType | None:
    """What an entry is, as diff's stat follows it; None, and the entry
    named in ``trouble``, for one it cannot stat or a link that leads
    nowhere.

    GNU names each such entry on each side and goes on with the rest, the
    pair left uncompared (exit 2).

    Args:
        walk (_Walk): the comparison's reads and its trouble list.
        path (PathSpec): the entry.
    """
    try:
        row = await walk.stat_fn(path)
    except FS_ERRORS as exc:
        walk.trouble.append(
            f"diff: {_name(path)}: {fs_strerror(exc)}\n".encode()
        )
        return None
    if row.type == FileType.SYMLINK:
        walk.trouble.append(
            f"diff: {_name(path)}: {posix_phrase(FsCondition.ENOENT)}\n".encode()
        )
        return None
    return row.type


async def _diff_dirs(
    dir_a: PathSpec,
    dir_b: PathSpec,
    walk: _Walk,
    absent: Absent = PRESENT,
    above: tuple[tuple[str, ...], tuple[str, ...]] = ((), ()),
) -> tuple[list[bytes], bool]:
    """Compare two directories, one of which -N may read as empty.

    Where diff follows links, a pair whose every side is a directory
    already open above it on that side is GNU's recursive directory
    loop: named and left unread (exit 2).

    Args:
        dir_a (PathSpec): the first directory.
        dir_b (PathSpec): the second directory.
        walk (_Walk): the reads and the parsed line.
        absent (Absent): which side is missing.
        above (tuple[tuple[str, ...], tuple[str, ...]]): each side's
            directories open above this pair, as the paths they resolve
            to.

    Returns:
        tuple[list[bytes], bool]: output chunks and whether any pair differed.
    """
    flags = walk.flags
    real = walk.real
    opened = (
        above
        if real is None
        else (
            above[0] if absent[0] else (*above[0], real(dir_a.virtual)),
            above[1] if absent[1] else (*above[1], real(dir_b.virtual)),
        )
    )
    names_a = await _entries(walk, dir_a, absent[0])
    names_b = await _entries(walk, dir_b, absent[1])
    left = _name(dir_a).rstrip("/")
    right = _name(dir_b).rstrip("/")
    parts: list[bytes] = []
    differ = False
    for name in sorted(names_a | names_b):
        in_a = name in names_a
        in_b = name in names_b
        if not in_b and not flags.new_file:
            parts.append(f"Only in {left}: {name}\n".encode())
            differ = True
            continue
        if not in_a and not flags.new_first:
            parts.append(f"Only in {right}: {name}\n".encode())
            differ = True
            continue
        child_a = _child_spec(dir_a, name)
        child_b = _child_spec(dir_b, name)
        kind_a = await _entry_kind(walk, child_a) if in_a else None
        kind_b = await _entry_kind(walk, child_b) if in_b else None
        if (in_a and kind_a is None) or (in_b and kind_b is None):
            continue
        a_dir = kind_a == FileType.DIRECTORY
        b_dir = kind_b == FileType.DIRECTORY
        gone = (not in_a, not in_b)
        if (a_dir or not in_a) and (b_dir or not in_b):
            if real is not None and all(
                side_gone or real(child.virtual) in side_open
                for side_gone, child, side_open in zip(
                    gone, (child_a, child_b), opened
                )
            ):
                named = _name(child_a if in_a else child_b)
                walk.trouble.append(
                    f"diff: {named}: recursive directory loop\n".encode()
                )
                continue
            children, changed = await _diff_dirs(
                child_a, child_b, walk, gone, opened
            )
            parts.extend(children)
            differ = differ or changed
        elif not a_dir and not b_dir:
            result = await _diff_pair(child_a, child_b, walk, gone)
            body = result.output
            walk.status = max(walk.status, result.status)
            if result.stderr:
                walk.trouble.extend(result.stderr)
            if result.outcome == "equal":
                parts.extend(body)
                continue
            differ = True
            if flags.brief:
                parts.extend(body)
            else:
                header = (
                    f"diff{walk.switches} {quote_header_name(_name(child_a))} "
                    f"{quote_header_name(_name(child_b))}\n"
                )
                parts.append(header.encode())
                parts.extend(body)
        elif a_dir:
            differ = True
            parts.append(
                (
                    f"File {_name(child_a)} is a directory while file "
                    f"{_name(child_b)} is a regular file\n"
                ).encode()
            )
        else:
            differ = True
            parts.append(
                (
                    f"File {_name(child_a)} is a regular file while file "
                    f"{_name(child_b)} is a directory\n"
                ).encode()
            )
    return parts, differ


async def _missing(
    stat_fn: Callable[..., Awaitable[FileStat]], path: PathSpec, allowed: bool
) -> bool:
    if not allowed or is_stdin(path):
        return False
    try:
        await stat_fn(path)
    except FileNotFoundError:
        return True
    return False


async def _excluded_patterns(
    flags: DiffFlags, stream: ReadStreamFn
) -> tuple[str, ...]:
    patterns = list(flags.exclude)
    for path in flags.exclude_from:
        text = (await materialize(stream(path))).decode(errors="replace")
        patterns.extend(line for line in text.split("\n") if line)
    return tuple(patterns)


async def diff(
    paths: list[PathSpec],
    *,
    stream: ReadStreamFn,
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[FileStat]],
    flags: DiffFlags,
    stdin: ByteSource | None = None,
    argv: Sequence[str] = (),
    stat_path: StatPath | None = None,
    zone: tzinfo | None = None,
    dispatch: DispatchFn | None = None,
    links: LinkView | None = None,
    computer: DiffComputer | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.DIFF, paths[2].raw_path)
    if len(paths) < 2:
        raise missing_operand_error(
            CommandName.DIFF, _name(paths[-1]) if paths else None, argv
        )
    if is_stdin(paths[0]) and is_stdin(paths[1]):
        # Both name the one stdin, which GNU sees as the same file.
        return None, IOResult()
    stream = stdin_stream(stream, stdin)
    stat_fn = stdin_stat(stat_fn)
    dashes = [p.raw_path == "-" for p in paths]
    walk: _Walk | None = None
    owned = DiffPool() if computer is None else None
    service = owned if owned is not None else computer
    assert service is not None
    try:
        walk = _Walk(
            computer=service,
            stream=stream,
            readdir_fn=readdir_fn,
            # diff compares what each link leads to (its default
            # --dereference), the operands' own taken there at dispatch.
            stat_fn=partial(followed_stat, stat_fn, links),
            real=links.resolve if links is not None else None,
            flags=flags,
            excluded=await _excluded_patterns(flags, stream),
            switches="".join(f" {shell_quote(w)}" for w in switch_words(argv)),
            stat_path=stat_path,
            zone=zone,
        )
        if any(dashes) and not all(dashes):
            other = paths[1] if dashes[0] else paths[0]
            if (await stat_fn(other)).type == FileType.DIRECTORY:
                return None, IOResult(
                    exit_code=2,
                    stderr=b"diff: cannot compare '-' to a directory\n",
                )
        # A missing operand -N reads as empty only beside one that is
        # there: two missing ones are both reported.
        absent = (
            await _missing(stat_fn, paths[0], flags.new_first),
            await _missing(stat_fn, paths[1], flags.new_file),
        )
        if all(absent):
            missing: list[bytes] = []
            for path in paths:
                try:
                    await stat_fn(path)
                except FS_ERRORS as exc:
                    missing.append(format_fs_error("diff", exc, [path]))
            return None, IOResult(exit_code=2, stderr=b"".join(missing))
        both_dirs = False
        if flags.recursive and not any(absent):
            both_dirs = (
                await stat_fn(paths[0])
            ).type == FileType.DIRECTORY and (
                await stat_fn(paths[1])
            ).type == FileType.DIRECTORY
        if both_dirs:
            for path in paths:
                await before_full_walk(dispatch, path, "diff")
            output, differ = await _diff_dirs(paths[0], paths[1], walk)
        else:
            result = await _diff_pair(paths[0], paths[1], walk, absent)
            output, differ = list(result.output), result.outcome == "different"
            walk.status = max(walk.status, result.status)
            if result.stderr:
                walk.trouble.extend(result.stderr)
    except RuntimeError as exc:
        return None, IOResult(exit_code=2, stderr=f"diff: {exc}\n".encode())
    except StreamRefusal as exc:
        return exc.output, IOResult(
            exit_code=2, stderr=(f"diff: {exc.message}\n").encode()
        )
    except FS_ERRORS as exc:
        # GNU diff reserves exit 1 for "files differ"; trouble (a missing
        # or unreadable operand) is exit 2.
        return None, IOResult(
            exit_code=2,
            stderr=format_fs_error("diff", exc, [*paths, *flags.exclude_from]),
        )
    finally:
        if owned is not None:
            await owned.close()
    assert walk is not None
    if walk.status == 2 or walk.trouble:
        return _output(output), IOResult(
            exit_code=2, stderr=b"".join(walk.trouble)
        )
    return _output(output), IOResult(exit_code=1 if differ else 0)


async def _output(parts: list[bytes]) -> AsyncIterator[bytes]:
    for part in parts:
        async for chunk in chunks(part):
            yield chunk


__all__ = ["diff"]


def parse_flags(flags: Mapping[str, FlagValue]) -> DiffFlags:
    fl = FlagView(flags, spec=SPECS["diff"])
    context = -1
    unified = fl.as_bool("u")
    for _, value in fl.occurrences("U", "unified"):
        unified = True
        if value is True:
            context = max(context, 3)
        elif (
            isinstance(value, str)
            and (
                value == ""
                or re.fullmatch(r"[ \t\n\r\v\f]*[+-]?[0-9]+", value)
            )
            and int(value or "0") >= 0
        ):
            context = max(context, min(int(value or "0"), INTMAX))
        else:
            raise UsageError(
                f"diff: invalid context length '{value}'\n"
                + usage_hint("diff")
            )
    new_file = fl.as_bool("new_file")
    return DiffFlags(
        ignore_case=fl.as_bool("i"),
        ignore_all_space=fl.as_bool("w"),
        ignore_space_change=fl.as_bool("b"),
        ed=fl.as_bool("e"),
        unified=unified,
        context=3 if context == -1 else context,
        brief=fl.as_bool("brief"),
        recursive=fl.as_bool("recursive"),
        new_file=new_file,
        new_first=new_file or fl.as_bool("unidirectional_new_file"),
        identical=fl.as_bool("report_identical_files"),
        exclude=tuple(fl.as_list("exclude")),
        exclude_from=tuple(fl.as_paths("exclude_from")),
    )


async def diff_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[FileStat]],
) -> tuple[ByteSource | None, IOResult]:
    return await diff(
        paths,
        stream=stream,
        readdir_fn=readdir_fn,
        stat_fn=stat_fn,
        flags=parse_flags(ctx.flags),
        stdin=ctx.stdin,
        argv=ctx.argv,
        stat_path=vfs_stat_path(ctx.vfs),
        zone=zone_from_env(ctx.env),
        dispatch=dispatch_of(ctx),
        links=links_of(ctx),
        computer=ctx.diff,
    )

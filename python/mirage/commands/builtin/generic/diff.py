import json
import logging
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass, field, replace
from datetime import tzinfo
from functools import partial

from mirage.commands.builtin.utils.formatting import (
    context_time,
    full_iso_time,
)
from mirage.commands.builtin.utils.links import dispatch_of, links_of
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.builtin.utils.tree import before_full_walk
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandName, FlagValue
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.concurrency.limiter import owned_task, settle
from mirage.core.api.errors import ApiError
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import format_fs_error
from mirage.errors.types import FsCondition
from mirage.io.cooperative import chunks
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.diff_pool import DiffPool
from mirage.rs.diff_types import (
    DiffComputer,
    DiffMode,
    DiffOptions,
    PairResult,
)
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import byte_view
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    Follow,
    JsonValue,
    LineFacts,
    PathSpec,
    ReadStreamFn,
)
from mirage.utils.clock import system_date
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey
from mirage.utils.path import gnu_basename
from mirage.utils.quote import shell_quote
from mirage.utils.timezone import zone_from_env
from mirage.view.namespace_view import followed_stat
from mirage.view.types import LinkView, StatPath

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class DiffFlags:
    """diff's line, parsed: one output style, what the comparison sets
    aside, and how lines are written; patterns and widths are spelled one
    character per byte, as the engine reads them."""

    options: DiffOptions = DiffOptions()
    labels: tuple[str, ...] = ()
    recursive: bool = False
    # -N reads a file missing on either side as empty, and
    # --unidirectional-new-file only one missing from the first.
    new_file: bool = False
    new_first: bool = False
    identical: bool = False
    exclude: tuple[str, ...] = ()
    exclude_from: tuple[PathSpec, ...] = ()
    # --no-dereference compares a link as itself: by the path it holds.
    no_dereference: bool = False
    # --from-file compares it with each operand, --to-file each with it.
    from_file: PathSpec | None = None
    to_file: PathSpec | None = None


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
    # A regular file's size, None when unknown, for -q to answer unread.
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None
    # The namespace's links, which --no-dereference reads as themselves.
    links: LinkView | None = None


Absent = tuple[bool, bool]

PRESENT: Absent = (False, False)

# How diff names each type but a regular file, which it calls a regular
# file or a regular empty file by its size (diffutils 3.10).
TYPE_NAMES = {
    FileType.DIRECTORY: "directory",
    FileType.SYMLINK: "symbolic link",
    FileType.CHAR_DEVICE: "character special file",
    FileType.BLOCK_DEVICE: "block special file",
    FileType.FIFO: "fifo",
    FileType.SOCKET: "socket",
}

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
    """The time a unified or context header gives one side, as diffutils
    prints it.

    The modification time as ``%Y-%m-%d %H:%M:%S.%N %z`` for a unified
    header and ``%a %b %e %T %Y`` for a context one, in the zone ``TZ``
    names, read through the dispatcher as ``stat`` reads it, so a time
    ``touch`` keeps in the namespace shows; the epoch for a side -N
    reads as absent; and the present moment for standard input, as
    POSIX asks and diffutils does.

    Args:
        walk (_Walk): the reads and the parsed line.
        path (PathSpec): the side.
        absent (bool): whether -N reads it as absent.
    """
    layout = (
        context_time if walk.flags.options.mode == "context" else full_iso_time
    )
    if absent:
        return layout(None, walk.zone)
    if is_stdin(path):
        now = system_date().isoformat()
        return layout(now, walk.zone)
    info = await walk.stat_path(path) if walk.stat_path is not None else None
    if info is None:
        info = await walk.stat_fn(path)
    return layout(info.modified, walk.zone)


def _labelled(walk: _Walk, path: PathSpec, side: int) -> str:
    """A side's name, or the --label given for it.

    Args:
        walk (_Walk): the parsed line.
        path (PathSpec): the side.
        side (int): 0 for the first file, 1 for the second.
    """
    labels = walk.flags.labels
    return labels[side] if side < len(labels) else _name(path)


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


async def _sizes_differ(
    walk: _Walk, paths: tuple[PathSpec, PathSpec], absent: Absent
) -> bool:
    """Whether -q knows the pair differs from its sizes alone: with no
    option that sets bytes aside it compares bytes, so two known sizes that
    differ answer it before either file is read. A stdin operand, a size not known, or a
    stat that fails leaves it to the read, which reports the failure.

    Args:
        walk (_Walk): the comparison's flags and sizes.
        paths (tuple[PathSpec, PathSpec]): the pair.
        absent (Absent): which side -N reads as empty.
    """
    flags = walk.flags.options
    if walk.size_of is None or (
        flags.ignore_case
        or flags.ignore_all_space
        or flags.ignore_space_change
        or flags.ignore_tab_expansion
        or flags.ignore_trailing_space
        or flags.strip_trailing_cr
        or flags.ignore_blank_lines
        or flags.ignore_lines
    ):
        return False
    sizes: list[int] = []
    for path, gone in zip(paths, absent, strict=True):
        if gone:
            sizes.append(0)
            continue
        if is_stdin(path):
            return False
        try:
            size = await walk.size_of(path)
        except FS_ERRORS as exc:
            logger.debug("diff: no size for %s: %s", path.virtual, exc)
            return False
        if size is None:
            return False
        sizes.append(size)
    return sizes[0] != sizes[1]


async def _diff_pair(
    path1: PathSpec,
    path2: PathSpec,
    walk: _Walk,
    absent: Absent = PRESENT,
) -> PairResult:
    flags = walk.flags
    name1 = _labelled(walk, path1, 0)
    name2 = _labelled(walk, path2, 1)
    headed = flags.options.mode in ("unified", "context")
    headers = []
    for side, (path, gone) in enumerate(
        ((path1, absent[0]), (path2, absent[1]))
    ):
        if not headed:
            headers.append("")
        elif side < len(flags.labels):
            headers.append(flags.labels[side])
        else:
            headers.append(
                quote_header_name(_name(path))
                + "\t"
                + await _header_time(walk, path, gone)
            )
    options = replace(
        flags.options,
        old_label=name1,
        new_label=name2,
        old_header=headers[0],
        new_header=headers[1],
    )
    if flags.options.brief and await _sizes_differ(
        walk, (path1, path2), absent
    ):
        result = PairResult("different", (), 1, ())
    else:
        result = await walk.computer.compare(
            options,
            partial(_side, walk, path1, absent[0]),
            partial(_side, walk, path2, absent[1]),
        )
    if result.outcome == "different" and options.brief and result.status == 1:
        return PairResult(
            result.outcome,
            (f"Files {name1} and {name2} differ\n".encode(),),
            result.status,
            result.stderr,
        )
    if result.outcome == "equal" and flags.identical and result.status == 0:
        return PairResult(
            result.outcome,
            (
                *result.output,
                f"Files {name1} and {name2} are identical\n".encode(),
            ),
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


def _link_text(walk: _Walk, path: PathSpec) -> str | None:
    """The path a link holds, where diff reads links as themselves
    (``--no-dereference``); None for anything else.

    Args:
        walk (_Walk): the comparison's reads and its parsed line.
        path (PathSpec): the entry.
    """
    if not walk.flags.no_dereference or walk.links is None:
        return None
    if is_stdin(path):
        return None
    row = walk.links.stat_at(path.virtual)
    if row is None or row.type != FileType.SYMLINK:
        return None
    target = row.extra.get(LINK_TARGET_KEY)
    return target if isinstance(target, str) else ""


def _kind_name(row: FileStat) -> str:
    """How diff names an entry's type when two differ: an empty regular
    file is a ``regular empty file`` (diffutils 3.10).

    Args:
        row (FileStat): the entry's stat.
    """
    named = TYPE_NAMES.get(row.type)
    if named is not None:
        return named
    return "regular empty file" if row.size == 0 else "regular file"


def _link_pair(
    walk: _Walk,
    paths: tuple[PathSpec, PathSpec],
    texts: tuple[str | None, str | None],
    rows: tuple[FileStat | None, FileStat | None],
) -> tuple[bytes | None, bool]:
    """What diff says of a pair one or both of which is a link it reads
    as itself, and whether the pair differs: two holding one path are
    equal (named identical under ``-s``), two holding different ones are
    ``Symbolic links ... differ``, and a link beside anything else names
    the two types.

    Args:
        walk (_Walk): the parsed line.
        paths (tuple[PathSpec, PathSpec]): the two entries.
        texts (tuple[str | None, str | None]): the path each holds, None
            for one that is no link.
        rows (tuple[FileStat | None, FileStat | None]): the stat of each
            that is no link, None for a link.
    """
    path_a, path_b = paths
    if texts[0] is not None and texts[1] is not None:
        if texts[0] != texts[1]:
            said = (
                f"Symbolic links {_name(path_a)} and {_name(path_b)} differ\n"
            )
            return said.encode(), True
        if not walk.flags.identical:
            return None, False
        said = (
            f"Files {_labelled(walk, path_a, 0)} and "
            f"{_labelled(walk, path_b, 1)} are identical\n"
        )
        return said.encode(), False
    names = [
        "symbolic link" if row is None else _kind_name(row) for row in rows
    ]
    return _mismatch(walk, paths, (names[0], names[1])), True


def _mismatch(
    walk: _Walk, paths: tuple[PathSpec, PathSpec], names: tuple[str, str]
) -> bytes:
    """GNU's report of a pair of two types, each side under its --label.

    Args:
        walk (_Walk): the parsed line.
        paths (tuple[PathSpec, PathSpec]): the two entries.
        names (tuple[str, str]): each one's type name.
    """
    return (
        f"File {_labelled(walk, paths[0], 0)} is a {names[0]} while file "
        f"{_labelled(walk, paths[1], 1)} is a {names[1]}\n"
    ).encode()


def _no_such(path: PathSpec) -> bytes:
    return (
        f"diff: {_name(path)}: {posix_phrase(FsCondition.ENOENT)}\n".encode()
    )


async def _entry_row(walk: _Walk, path: PathSpec) -> FileStat | None:
    """An entry's stat, as diff's stat follows it; None, and the entry
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
        walk.trouble.append(_no_such(path))
        return None
    return row


async def _diff_dirs(
    dir_a: PathSpec,
    dir_b: PathSpec,
    walk: _Walk,
    parts: list[ByteSource],
    absent: Absent = PRESENT,
    above: tuple[tuple[str, ...], tuple[str, ...]] = ((), ()),
) -> bool:
    """Compare two directories, one of which -N may read as empty.

    Where diff follows links, a pair whose every side is a directory
    already open above it on that side is GNU's recursive directory
    loop: named and left unread (exit 2).

    Args:
        dir_a (PathSpec): the first directory.
        dir_b (PathSpec): the second directory.
        walk (_Walk): the reads and the parsed line.
        parts (list[ByteSource]): the output so far, which the caller
            closes if the walk fails.
        absent (Absent): which side is missing.
        above (tuple[tuple[str, ...], tuple[str, ...]]): each side's
            directories open above this pair, as the paths they resolve
            to.

    Returns:
        bool: whether any pair differed.
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
        texts = (
            _link_text(walk, child_a) if in_a else None,
            _link_text(walk, child_b) if in_b else None,
        )
        if texts != (None, None):
            # -N reads no link's peer as empty: GNU names the missing one.
            if not (in_a and in_b):
                walk.trouble.append(_no_such(child_b if in_a else child_a))
                continue
            peers = (
                None
                if texts[0] is not None
                else await _entry_row(walk, child_a),
                None
                if texts[1] is not None
                else await _entry_row(walk, child_b),
            )
            if any(t is None and r is None for t, r in zip(texts, peers)):
                continue
            said, changed = _link_pair(walk, (child_a, child_b), texts, peers)
            if said is not None:
                parts.append(said)
            differ = differ or changed
            continue
        row_a = await _entry_row(walk, child_a) if in_a else None
        row_b = await _entry_row(walk, child_b) if in_b else None
        if (in_a and row_a is None) or (in_b and row_b is None):
            continue
        kind_a = row_a.type if row_a is not None else None
        kind_b = row_b.type if row_b is not None else None
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
            changed = await _diff_dirs(
                child_a, child_b, walk, parts, gone, opened
            )
            differ = differ or changed
        elif not a_dir and not b_dir:
            result = await _diff_pair(child_a, child_b, walk, gone)
            body = result.output
            walk.status = max(walk.status, result.status)
            if result.stderr:
                walk.trouble.extend(result.stderr)
            differ = differ or result.outcome == "different"
            # Side by side shows an equal pair's common lines too, so its
            # header comes with every pair the lines are not suppressed for.
            if not flags.options.brief and (
                result.outcome == "different"
                or (
                    flags.options.mode == "sides"
                    and not flags.options.suppress_common
                )
            ):
                header = (
                    f"diff{walk.switches} "
                    f"{quote_header_name(_labelled(walk, child_a, 0))} "
                    f"{quote_header_name(_labelled(walk, child_b, 1))}\n"
                )
                parts.append(header.encode())
            parts.extend(body)
        else:
            assert row_a is not None and row_b is not None
            differ = True
            parts.append(
                _mismatch(
                    walk,
                    (child_a, child_b),
                    (_kind_name(row_a), _kind_name(row_b)),
                )
            )
    return differ


async def _operand_row(
    walk: _Walk, stat_fn: Callable[..., Awaitable[FileStat]], path: PathSpec
) -> tuple[FileStat | None, bytes]:
    """An operand's stat as diff reads it, and the error that stat met.

    A link diff reads as itself is its own row; any other link is
    followed, and one that leads nowhere is None, as a missing operand
    is, with no error, since -N may read either as empty.

    Args:
        walk (_Walk): the comparison's links and parsed line.
        stat_fn (Callable[..., Awaitable[FileStat]]): the operands' own
            stat, which answers for stdin.
        path (PathSpec): the operand.
    """
    if _link_text(walk, path) is not None and walk.links is not None:
        return walk.links.stat_at(path.virtual), b""
    try:
        row = await (stat_fn if is_stdin(path) else walk.stat_fn)(path)
    except FileNotFoundError:
        return None, b""
    except FS_ERRORS as exc:
        return None, format_fs_error("diff", exc, [path])
    return (None if row.type == FileType.SYMLINK else row), b""


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
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Compare two operands, or, under ``--from-file`` or ``--to-file``,
    that file with each operand in turn: each comparison's output in
    order, its errors in order, and the worst status of them.

    Args:
        paths (list[PathSpec]): the operands.
        stream (ReadStreamFn): reads a file.
        readdir_fn (Callable[..., Awaitable[list[str]]]): lists a folder.
        stat_fn (Callable[..., Awaitable[FileStat]]): stats a path.
        flags (DiffFlags): the parsed options.
        stdin (ByteSource | None): what a ``-`` operand reads.
        argv (Sequence[str]): the words as typed, for ``-r`` headers.
        stat_path (StatPath | None): stats a path for header times.
        zone (tzinfo | None): the zone header times are written in.
        dispatch (DispatchFn | None): the op dispatcher.
        links (LinkView | None): the session's links.
        computer (DiffComputer | None): the diff engine; None owns one.
        size_of (Callable[[PathSpec], Awaitable[int | None]] | None): a
            regular file's size, for ``-q`` to answer unread.
    """
    compare = partial(
        _compare,
        stream=stream,
        readdir_fn=readdir_fn,
        stat_fn=stat_fn,
        flags=flags,
        stdin=stdin,
        argv=argv,
        stat_path=stat_path,
        zone=zone,
        dispatch=dispatch,
        links=links,
        computer=computer,
        size_of=size_of,
    )
    if flags.from_file is None and flags.to_file is None:
        return await compare(paths)
    parts: list[ByteSource] = []
    errors: list[bytes] = []
    status = 0
    read_stdin = False
    try:
        for path in paths:
            pair = (
                [flags.from_file, path]
                if flags.from_file is not None
                else [path, flags.to_file]
            )
            sides = [p for p in pair if p is not None]
            dash = next((p for p in sides if is_stdin(p)), None)
            if dash is not None and read_stdin:
                # The first comparison read stdin to its end.
                errors.append(
                    f"diff: {dash.raw_path}: Bad file descriptor\n".encode()
                )
                status = 2
                continue
            read_stdin = read_stdin or dash is not None
            output, io = await compare(sides)
            if output is not None:
                parts.append(output)
            errors.append(await io.materialize_stderr())
            status = max(status, io.exit_code)
    except BaseException:
        await settle(owned_task(_close_parts(parts)))
        raise
    return _output(parts), IOResult(exit_code=status, stderr=b"".join(errors))


async def _compare(
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
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
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
            links=links,
            flags=flags,
            excluded=await _excluded_patterns(flags, stream),
            switches="".join(f" {shell_quote(w)}" for w in switch_words(argv)),
            stat_path=stat_path,
            zone=zone,
            size_of=size_of,
        )
        # GNU stats both operands before it reads either: a missing one
        # is named at once, and a directory beside anything else stands
        # for its entry of that one's name.
        probes = [await _operand_row(walk, stat_fn, path) for path in paths]
        rows = [row for row, _ in probes]
        if (rows[0] is None and rows[1] is None) or any(e for _, e in probes):
            # GNU names every operand it could not stat, -N or not.
            return None, IOResult(
                exit_code=2,
                stderr=b"".join(
                    said or (_no_such(path) if row is None else b"")
                    for path, (row, said) in zip(paths, probes)
                ),
            )
        kinds = [None if row is None else row.type for row in rows]
        if any(dashes) and not all(dashes):
            if kinds[1 if dashes[0] else 0] == FileType.DIRECTORY:
                return None, IOResult(
                    exit_code=2,
                    stderr=b"diff: cannot compare '-' to a directory\n",
                )
        dirs = [kind == FileType.DIRECTORY for kind in kinds]
        entry_side: int | None = None
        if None not in kinds and dirs[0] != dirs[1]:
            entry_side = 0 if dirs[0] else 1
            entry = _child_spec(
                paths[entry_side], gnu_basename(_name(paths[1 - entry_side]))
            )
            paths = [entry, paths[1]] if entry_side == 0 else [paths[0], entry]
            rows[entry_side], error = await _operand_row(walk, stat_fn, entry)
            if error:
                return None, IOResult(exit_code=2, stderr=error)
        texts = (_link_text(walk, paths[0]), _link_text(walk, paths[1]))
        # -N reads a missing operand as empty, but neither beside a link
        # read as itself nor as a directory's entry: GNU names those.
        absent = (
            rows[0] is None and flags.new_first and texts[1] is None,
            rows[1] is None and flags.new_file and texts[0] is None,
        )
        for side, (path, row) in enumerate(zip(paths, rows)):
            if row is None and (not absent[side] or side == entry_side):
                return None, IOResult(exit_code=2, stderr=_no_such(path))
        if texts != (None, None):
            said, differ = _link_pair(
                walk,
                (paths[0], paths[1]),
                texts,
                (
                    None if texts[0] is not None else rows[0],
                    None if texts[1] is not None else rows[1],
                ),
            )
            return (
                None if said is None else _output([said]),
                IOResult(exit_code=1 if differ else 0),
            )
        if entry_side is not None:
            row_a, row_b = rows
            assert row_a is not None and row_b is not None
            if FileType.DIRECTORY in (row_a.type, row_b.type):
                said = _mismatch(
                    walk,
                    (paths[0], paths[1]),
                    (_kind_name(row_a), _kind_name(row_b)),
                )
                return _output([said]), IOResult(exit_code=1)
        if flags.recursive and all(dirs):
            for path in paths:
                await before_full_walk(dispatch, path, "diff")
            output: list[ByteSource] = []
            try:
                differ = await _diff_dirs(paths[0], paths[1], walk, output)
            except BaseException:
                await settle(owned_task(_close_parts(output)))
                raise
        else:
            result = await _diff_pair(paths[0], paths[1], walk, absent)
            output, differ = list(result.output), result.outcome == "different"
            walk.status = max(walk.status, result.status)
            if result.stderr:
                walk.trouble.extend(result.stderr)
    except (ApiError, RuntimeError) as exc:
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


async def _output_chunks(parts: Sequence[ByteSource]) -> AsyncIterator[bytes]:
    for part in parts:
        async for chunk in chunks(part):
            yield chunk


async def _close_parts(parts: Sequence[ByteSource]) -> None:
    for part in parts:
        await close_quietly(part)


def _output(parts: Sequence[ByteSource]) -> OutputStream:
    return OutputStream(_output_chunks(parts), partial(_close_parts, parts))


__all__ = ["diff"]


# Each output style and the options that ask for it.
_STYLES: dict[DiffMode, tuple[str, ...]] = {
    "normal": ("normal",),
    "context": ("c", "C", "context"),
    "unified": ("u", "U", "unified"),
    "ed": ("ed",),
    "rcs": ("rcs",),
    "sides": ("side_by_side",),
}
_HINT = "diff: Try 'diff --help' for more information.\n"
_WHEN = ("always", "never", "auto")


def _typed(fl: FlagView, *names: str) -> list[str | None]:
    """Each value the options were typed with, in order, None for a bare
    long one.

    Args:
        fl (FlagView): the parsed flags.
        names (str): the options.
    """
    return [
        None if value is True else str(value)
        for _, value in fl.occurrences(*names)
        if value not in (None, False)
    ]


def _engine_checks(
    lengths: list[str | None],
    widths: list[str],
    ignore_lines: list[str],
    function_lines: list[str],
) -> int | IOResult:
    """The context the context and unified options give, with every
    length, width and pattern checked by the diff engine before any
    operand is read.

    Args:
        lengths (list[str | None]): each context length as typed, None
            for a bare long option.
        widths (list[str]): each -W as typed.
        ignore_lines (list[str]): each -I.
        function_lines (list[str]): each -F.
    """
    config: dict[str, JsonValue] = {
        "lengths": [
            None if text is None else byte_view(text) for text in lengths
        ],
        "widths": [byte_view(text) for text in widths],
        "ignore_lines": [byte_view(text) for text in ignore_lines],
        "function_lines": [byte_view(text) for text in function_lines],
    }
    try:
        engine = open_stream("diff", config)
    except StreamRefusal as refusal:
        return refused(refusal)
    context = json.loads(engine.metadata())["context"]
    return int(context)


def parse_flags(
    flags: Mapping[str, FlagValue], utf8: bool = False
) -> DiffFlags | IOResult:
    """diff's options, the ones diffutils refuses before any operand
    refused here: two output styles, a third --label, an unknown
    --color, and a length, width or pattern the diff engine refuses.
    A valid --color changes nothing: output is never colored.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.
        utf8 (bool): the session reads text as UTF-8.

    Returns:
        DiffFlags | IOResult: the flags, or diff's refusal, exit 2.
    """
    fl = FlagView(flags, spec=SPECS["diff"])
    styles = [
        style
        for style, names in _STYLES.items()
        if any(
            value not in (None, False) for _, value in fl.occurrences(*names)
        )
    ]
    if len(styles) > 1:
        return IOResult(
            exit_code=2,
            stderr=f"diff: conflicting output style options\n{_HINT}".encode(),
        )
    for horizon in fl.as_list("horizon_lines"):
        if not (horizon.isascii() and horizon.isdigit()):
            return IOResult(
                exit_code=2,
                stderr=f"diff: invalid horizon length '{horizon}'\n"
                f"{_HINT}".encode(),
            )
    labels = tuple(fl.as_list("label"))
    if len(labels) > 2:
        return IOResult(
            exit_code=2, stderr=b"diff: too many file label options\n"
        )
    for value in _typed(fl, "color"):
        if value is not None and value not in _WHEN:
            return IOResult(
                exit_code=2,
                stderr=f"diff: invalid color '{value}'\n{_HINT}".encode(),
            )
    show_c_function = fl.as_bool("show_c_function")
    mode: DiffMode = (
        styles[0] if styles else "context" if show_c_function else "normal"
    )
    ignore_lines = fl.as_list("ignore_matching_lines")
    function_lines = fl.as_list("show_function_line")
    widths = [text for text in _typed(fl, "width") if text is not None]
    lengths = _typed(fl, "C", "context", "U", "unified")
    context = _engine_checks(lengths, widths, ignore_lines, function_lines)
    if isinstance(context, IOResult):
        return context
    new_file = fl.as_bool("new_file")
    fixed: dict[str, PathSpec | None] = {}
    for option in ("from_file", "to_file"):
        given = fl.as_paths(option)
        spelled = [p.raw_path or p.virtual for p in given]
        other = next((s for s in spelled if s != spelled[0]), None)
        if other is not None:
            name = option.replace("_", "-")
            return IOResult(
                exit_code=2,
                stderr=f"diff: conflicting --{name} option value '{other}'\n"
                f"{_HINT}".encode(),
            )
        fixed[option] = given[0] if given else None
    if fixed["from_file"] is not None and fixed["to_file"] is not None:
        return IOResult(
            exit_code=2,
            stderr=b"diff: --from-file and --to-file both specified\n",
        )
    return DiffFlags(
        options=DiffOptions(
            mode=mode,
            ignore_case=fl.as_bool("ignore_case"),
            ignore_all_space=fl.as_bool("ignore_all_space"),
            ignore_space_change=fl.as_bool("ignore_space_change"),
            ignore_tab_expansion=fl.as_bool("ignore_tab_expansion"),
            ignore_trailing_space=fl.as_bool("ignore_trailing_space"),
            strip_trailing_cr=fl.as_bool("strip_trailing_cr"),
            ignore_blank_lines=fl.as_bool("ignore_blank_lines"),
            ignore_lines=tuple(byte_view(text) for text in ignore_lines),
            function_lines=tuple(byte_view(text) for text in function_lines),
            show_c_function=show_c_function,
            expand_tabs=fl.as_bool("expand_tabs"),
            initial_tab=fl.as_bool("initial_tab"),
            widths=tuple(byte_view(text) for text in widths),
            suppress_common=fl.as_bool("suppress_common_lines"),
            left_column=fl.as_bool("left_column"),
            text=fl.as_bool("text"),
            utf8=utf8,
            context=context,
            brief=fl.as_bool("brief"),
        ),
        labels=labels,
        recursive=fl.as_bool("recursive"),
        new_file=new_file,
        new_first=new_file or fl.as_bool("unidirectional_new_file"),
        identical=fl.as_bool("report_identical_files"),
        exclude=tuple(fl.as_list("exclude")),
        exclude_from=tuple(fl.as_paths("exclude_from")),
        no_dereference=fl.as_bool("no_dereference"),
        from_file=fixed["from_file"],
        to_file=fixed["to_file"],
    )


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A diff line follows its operands' links, unless
    ``--no-dereference`` compares each link as itself.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    if fl.as_bool("no_dereference"):
        return LineFacts(follows=Follow.NONE)
    return LineFacts()


async def diff_generic(
    parsed: DiffFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
    readdir_fn: Callable[..., Awaitable[list[str]]],
    stat_fn: Callable[..., Awaitable[FileStat]],
    size_of: Callable[[PathSpec], Awaitable[int | None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    return await diff(
        paths,
        stream=stream,
        readdir_fn=readdir_fn,
        stat_fn=stat_fn,
        flags=parsed,
        stdin=ctx.stdin,
        argv=ctx.argv,
        stat_path=vfs_stat_path(ctx.vfs),
        zone=zone_from_env(ctx.env),
        dispatch=dispatch_of(ctx),
        links=links_of(ctx),
        computer=ctx.diff,
        size_of=size_of,
    )

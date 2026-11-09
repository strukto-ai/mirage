import logging
import math
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from functools import partial

from mirage.commands.builtin.utils.formatting import (
    BlockSize,
    block_size_of,
    full_iso_time,
    nanoseconds_of,
    scaled_size,
)
from mirage.commands.builtin.utils.links import mounts_of
from mirage.commands.builtin.utils.operands import at_offsets
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import ZERO_LENGTH_NAME
from mirage.errors.types import DotWalkError, FsCondition
from mirage.io.types import ByteSource, IOResult, PathRecord
from mirage.rs.errors import StreamRefusal
from mirage.rs.glob import any_tail_matcher
from mirage.rs.scan import refused, scan
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import FileStat, Follow, LineFacts, LsTimeKind, PathSpec
from mirage.utils.dates import iso_timestamp
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import respell_one, respell_raw
from mirage.view.namespace_view import paths_scoped
from mirage.view.types import MountView, StatPath

logger = logging.getLogger(__name__)

DuEntries = tuple[list[tuple[str, int]], int]
ComputeSize = Callable[[PathSpec], Awaitable[int]]
ComputeEntries = Callable[[PathSpec], Awaitable[DuEntries]]
# A time as an ordering key and the stamp it was read from.
Newest = tuple[float, str]

_HINT = "Try 'du --help' for more information.\n"
_TIMES = {"atime": LsTimeKind.ATIME, "ctime": LsTimeKind.CTIME}


@dataclass(frozen=True, slots=True)
class DuFlags:
    """Parsed ``du`` command line.

    Args:
        s (bool): -s, one total per operand and no subtree lines.
        a (bool): -a, list files as well as directories.
        h (bool): -h, human-readable sizes.
        block_size (BlockSize | None): explicit unit, or None for bytes/-h.
        c (bool): -c, append a grand total.
        S (bool): -S/--separate-dirs, directories exclude subdirectory sizes.
        max_depth (int | None): --max-depth/-d, deepest level to print.
        warning (str | None): a non-fatal diagnostic GNU prints before the
            output, without failing the command.
        inodes (bool): --inodes, count entries rather than bytes: a file
            is one, a directory one plus what it holds; only ``-h`` and
            ``--si`` scale the count.
        threshold (int | None): -t/--threshold, print a row only at or
            above this size, or at or below its magnitude when negative;
            the ``total`` row always prints.
        time (LsTimeKind | None): --time, the clock of the time column:
            each row shows the newest time in its tree; None prints none.
        time_style (str): --time-style or ``TIME_STYLE``: ``full-iso``,
            ``long-iso``, ``iso`` or ``+FORMAT``.
        null (bool): -0/--null, end each row with NUL.
        excludes (tuple[str, ...]): --exclude and -X patterns; an entry
            whose path, as du prints it, or the part after any slash in
            it matches one is neither walked nor counted.
    """

    s: bool = False
    a: bool = False
    h: bool = False
    block_size: BlockSize | None = None
    c: bool = False
    S: bool = False
    max_depth: int | None = None
    warning: str | None = None
    inodes: bool = False
    threshold: int | None = None
    time: LsTimeKind | None = None
    time_style: str = "long-iso"
    null: bool = False
    excludes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DuOutput:
    """What ``du`` produced for one invocation.

    Args:
        stdout (bytes): The rendered size lines.
        stderr (bytes): Diagnostics: unreadable operands, then the
            truncation notice.
        exit_code (int): 0, or 1 when an operand could not be read or a
            walk was cut short (GNU exits 1 when it could not fully
            account for every operand).
        records (list[PathRecord] | None): each readable operand's
            measurement, None when one was only summed (``-s``, or a
            backend that can only produce a size).
        notes (list[tuple[int, bytes]]): each stderr line with the
            offset in ``stdout`` it goes before (``at_offsets``).
    """

    stdout: bytes
    stderr: bytes
    exit_code: int
    records: list[PathRecord] | None = None
    notes: list[tuple[int, bytes]] = field(default_factory=list)


def parse_flags(ctx: Context) -> DuFlags | IOResult:
    """du's options, ``--max-depth`` and its conflicts with ``-s`` and
    ``-a`` read by mirage-rs before any operand is resolved.

    The time style is read only under ``--time``, from
    ``--time-style`` or else the ``TIME_STYLE`` variable.

    Args:
        ctx (Context): the flags as the dispatcher parsed them.

    Returns:
        DuFlags | IOResult: the flags, or du's refusal.
    """
    fl = FlagView(ctx.flags, spec=SPECS["du"])
    typed = fl.texts(
        "max_depth",
        "summarize",
        "all",
        "human_readable",
        "si",
        "bytes",
        "apparent_size",
        "k",
        "m",
        "block_size",
        "inodes",
        "t",
        "threshold",
    )
    when = fl.raw("time")
    timed = when is not None and when is not False
    if isinstance(when, str):
        typed.append(("time", when))
    style = fl.as_str("time_style")
    if style is None and ctx.env is not None:
        style = ctx.env.get("TIME_STYLE")
    if timed and style is not None:
        typed.append(("time_style", style))
    try:
        values = scan("du", typed)
    except StreamRefusal as refusal:
        return refused(refusal)
    depth = values["max_depth"]
    warning = values["warning"]
    limit = values["threshold"]
    word = values["time"]
    shape = values["time_style"]
    assert depth is None or isinstance(depth, int)
    assert warning is None or isinstance(warning, str)
    assert limit is None or isinstance(limit, str)
    assert word is None or isinstance(word, str)
    assert shape is None or isinstance(shape, str)
    return DuFlags(
        s=fl.as_bool("summarize"),
        a=fl.as_bool("all"),
        h=fl.as_bool("human_readable"),
        block_size=block_size_of(values["block_size"]),
        c=fl.as_bool("total"),
        S=fl.as_bool("separate_dirs"),
        max_depth=depth,
        warning=warning,
        inodes=fl.as_bool("inodes"),
        threshold=None if limit is None else int(limit),
        time=(
            None
            if not timed
            else _TIMES[word]
            if word is not None
            else LsTimeKind.MTIME
        ),
        time_style=shape or "long-iso",
        null=fl.as_bool("null"),
        excludes=tuple(fl.as_list("exclude")),
    )


async def read_flags(
    ctx: Context, stream: Callable[[PathSpec], AsyncIterator[bytes]]
) -> DuFlags | IOResult:
    """du's options with every ``-X`` file read into its patterns, one a
    line; a file that cannot be read is refused, exit 1.

    Args:
        ctx (Context): the flags as the dispatcher parsed them.
        stream (Callable[[PathSpec], AsyncIterator[bytes]]): reads a
            pattern file, ``-`` from stdin.

    Returns:
        DuFlags | IOResult: the flags, or du's refusal.
    """
    flags = parse_flags(ctx)
    if isinstance(flags, IOResult):
        return flags
    patterns = list(flags.excludes)
    for source in FlagView(ctx.flags, spec=SPECS["du"]).as_paths(
        "exclude_from"
    ):
        held = bytearray()
        try:
            async for chunk in stream(source):
                held += chunk
        except FS_ERRORS as exc:
            line = f"du: {source.raw_path}: {fs_strerror(exc)}\n{_HINT}"
            return IOResult(exit_code=1, stderr=line.encode())
        patterns.extend(
            line for line in decode_text(bytes(held)).split("\n") if line
        )
    return replace(flags, excludes=tuple(patterns))


def excluded(patterns: Sequence[str], shown: str) -> bool:
    """Whether ``--exclude`` or ``-X`` leaves a path out: a pattern that
    matches it whole, or the part after any slash in it.

    Args:
        patterns (Sequence[str]): the patterns.
        shown (str): the path as du prints it.
    """
    if not patterns:
        return False
    return any_tail_matcher(tuple(patterns)).matches(shown)


def excluded_start(
    patterns: Sequence[str], operand: PathSpec, start: PathSpec
) -> bool:
    """Whether a mount root below an operand is, or lies under, a path
    ``--exclude`` or ``-X`` leaves out: the walk never reaches it, so it
    is not measured.

    Args:
        patterns (Sequence[str]): the patterns.
        operand (PathSpec): the operand.
        start (PathSpec): a mount root below it.
    """
    base = operand.virtual.rstrip("/")
    rest = start.virtual[len(base) :].strip("/")
    if not patterns or not rest:
        return False
    steps = rest.split("/")
    return any(
        excluded(
            patterns,
            respell_one(
                "/".join([base, *steps[: n + 1]]),
                operand.virtual,
                operand.raw_path,
            ),
        )
        for n in range(len(steps))
    )


def cwd_spec(cwd: PathSpec | str) -> PathSpec:
    """Build the operand GNU ``du`` assumes when the line names none.

    Args:
        cwd (PathSpec | str): the session's working directory.
    """
    if isinstance(cwd, PathSpec):
        return cwd
    return PathSpec(
        virtual=cwd, directory=cwd, resolved=False, vfs_path=cwd.strip("/")
    )


async def du_operands(
    paths: list[PathSpec],
    cwd: PathSpec | str,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    has_content: Callable[[PathSpec], Awaitable[bool]] | None = None,
    stat_path: StatPath | None = None,
    excludes: Sequence[str] = (),
) -> tuple[list[PathSpec], list[tuple[str, str, int]]]:
    """Split the operands into the ones du can read and the ones it cannot.

    GNU names every operand it fails to stat, keeps going with the rest,
    and exits 1. With no operand at all it measures the working
    directory.

    A failed stat is not proof of absence, and du runs bound to one
    backend, so its own stat cannot see a mount nested below a path,
    which makes it a real directory from another VFS. ``stat_path`` is
    the channel that knows, because it resolves
    through the dispatcher rather than one accessor, and it is the same
    probe ``find`` classifies its start point with. Session filtering
    rides along with it: a mount the session may not see contributes no
    directory here, so absence stays the answer for it.

    ``has_content`` is the second channel behind that, for a backend that
    never materialises a directory entry for its own mount root (redis is
    one) while the subtree below it is full. It counts only what the
    session may see, so it cannot re-open what the first channel closed.

    Args:
        paths (list[PathSpec]): the operands as parsed, possibly empty.
        cwd (PathSpec | str): the working directory, used when empty.
        resolve_glob (Callable[[list[PathSpec]], Awaitable[list[PathSpec]]]):
            expands globs against the backend.
        stat (Callable[[PathSpec], Awaitable[FileStat]]):
            raises when an operand cannot be read.
        has_content (Callable[[PathSpec], Awaitable[bool]] | None):
            asked only when stat failed, to
            tell an implicit directory from an absent path.
        stat_path (StatPath | None): dispatcher-backed stat, None when du
            runs outside a workspace and there is no namespace to ask.
        excludes (Sequence[str]): the ``--exclude`` patterns; an operand
            one matches is dropped before it is stat'ed, so a missing
            one is not reported either.

    Returns:
        tuple[list[PathSpec], list[tuple[str, str, int]]]: readable
        operands, then the as-typed spelling of each unreadable one with
        the strerror to report it with and how many readable operands
        came before it.
    """
    targets = paths if paths else [cwd_spec(cwd)]
    resolved = await resolve_glob(targets)
    present: list[PathSpec] = []
    missing: list[tuple[str, str, int]] = []
    if not resolved:
        # An unmatched glob reaches GNU as the literal pattern, which it
        # then reports as unreadable.
        missing = [
            (p.raw_path, posix_phrase(FsCondition.ENOENT), 0)
            for p in targets
            if not excluded(excludes, p.raw_path)
        ]
    for path in resolved:
        if excluded(excludes, path.raw_path):
            continue
        try:
            await stat(path)
            stattable = True
        except DotWalkError as exc:
            # The operand did not resolve, so no channel asked about the
            # path it simplifies to can find it there.
            missing.append(
                (
                    path.raw_path,
                    fs_strerror(exc) or posix_phrase(FsCondition.ENOENT),
                    len(present),
                )
            )
            continue
        except NotADirectoryError:
            # An operand typed with a trailing slash that did not name a
            # directory. Unreadable like a missing one, but GNU reports
            # the errno it got, so the two cannot share a wording.
            missing.append(
                (
                    path.raw_path,
                    posix_phrase(FsCondition.ENOTDIR),
                    len(present),
                )
            )
            continue
        except (FileNotFoundError, ValueError):
            stattable = False
        try:
            exists = await du_operand_exists(
                path, stattable, has_content, stat_path
            )
        except PermissionError as exc:
            # The dispatcher refuses to stat it: GNU names the errno it got
            # (`du: cannot access 'P': Permission denied`).
            missing.append(
                (path.raw_path, fs_strerror(exc) or str(exc), len(present))
            )
            continue
        if not exists:
            missing.append(
                (path.raw_path, posix_phrase(FsCondition.ENOENT), len(present))
            )
            continue
        present.append(path)
    return present, missing


async def du_operand_exists(
    path: PathSpec,
    stattable: bool,
    has_content: Callable[[PathSpec], Awaitable[bool]] | None,
    stat_path: StatPath | None,
) -> bool:
    """Whether one operand is there at all, before anything is measured.

    A point lookup alone cannot decide, so this asks both channels a
    backend can answer on, the way ``find`` classifies its start point:
    on a prefix store a directory is not an object, it is the set of keys
    under it, so ``stat`` misses what a listing would show (redis never
    materialises an entry for its own mount root). Absence takes both
    coming back empty.

    Where a dispatcher is wired it replaces the bound backend's stat,
    because that stat sees one accessor and knows nothing of hides:
    trusting it answered ``0 <path>`` for a hidden directory and
    confirmed to the agent what the profile was not meant to show it. The
    content probe behind it counts only what the session may see, so it
    cannot re-open what the first channel closed.

    Args:
        path (PathSpec): the operand.
        stattable (bool): whether the bound backend's stat succeeded.
        has_content (Callable[[PathSpec], Awaitable[bool]] | None):
            the content probe, which tells
            an implicit directory from an absent path.
        stat_path (StatPath | None): dispatcher-backed stat.
    """
    if stat_path is None and stattable:
        return True
    if stat_path is not None and await stat_path(path) is not None:
        return True
    return has_content is not None and await has_content(path)


async def du_has_content(
    compute_entries: ComputeEntries, path: PathSpec
) -> bool:
    """Whether an operand holds anything the session may see.

    Safe to ask after the dispatcher already said no: ``compute_entries``
    walks through the command's files, whose every listing the
    dispatcher filters by the session's hides, so a walled-off subtree
    answers no entries and its parent stays unconfirmed.

    Args:
        compute_entries (ComputeEntries): per-file breakdown.
        path (PathSpec): the operand to probe.
    """
    try:
        entries, _ = await compute_entries(path)
        return bool(entries)
    except Exception as exc:
        # This runs only after stat already failed, to tell an implicit
        # directory from an absent path. Backends raise their own error
        # types here (Graph 404, SFTP no-such-file), and every one of
        # them means the same thing: nothing to measure. Surfacing it
        # would replace GNU's "cannot access" line with a driver error.
        logger.debug("du: content probe failed for %s: %r", path.virtual, exc)
        return False


def _line(
    size: int, flags: DuFlags, label: str, newest: Newest | None = None
) -> str:
    block = flags.block_size
    if flags.inodes and block is not None and block.human_base is None:
        block = None
    shown = scaled_size(size, block, flags.h)
    if flags.time is not None:
        shown += "\t" + _stamp(newest[1] if newest else None, flags.time_style)
    return shown + "\t" + label


def _stamp(modified: str | None, style: str) -> str:
    """A row's time under du's ``--time-style``: ``full-iso`` as ``ls``
    spells it, ``long-iso``, ``iso`` (a date alone, whatever its age) or
    a ``+FORMAT``; an unknown time is the epoch.

    Args:
        modified (str | None): the ISO timestamp.
        style (str): the style.
    """
    if style == "full-iso":
        return full_iso_time(modified)
    seconds = iso_timestamp(modified)
    when = datetime.fromtimestamp(math.floor(seconds or 0), timezone.utc)
    fmt = {"long-iso": "%Y-%m-%d %H:%M", "iso": "%Y-%m-%d"}.get(
        style, style[1:]
    )
    fraction = 0 if seconds is None else nanoseconds_of(modified)
    return gnu_strftime(when, fmt, nanosecond=fraction)


def _kept(size: int, flags: DuFlags) -> bool:
    """Whether ``-t`` lets a row print.

    Args:
        size (int): the row's bytes, or its count under ``--inodes``.
        flags (DuFlags): the parsed command line.
    """
    limit = flags.threshold
    if limit is None:
        return True
    return size >= limit if limit >= 0 else size <= -limit


def newest_under(times: Mapping[str, str], root: str) -> dict[str, Newest]:
    """The newest time in each directory's tree under ``root``, for
    ``--time``: each entry's time is carried up to the root, stopping at
    an ancestor that already holds a newer one, since every ancestor of
    that one does too.

    Args:
        times (Mapping[str, str]): each entry's time by virtual path.
        root (str): the operand's virtual path.
    """
    root_key = _norm(root)
    prefix = root_key if root_key.endswith("/") else root_key + "/"
    best: dict[str, Newest] = {}
    for virtual, stamp in times.items():
        node = _norm(virtual)
        key = iso_timestamp(stamp)
        if key is None or (node != root_key and not node.startswith(prefix)):
            continue
        while True:
            held = best.get(node)
            if held is not None and held[0] >= key:
                break
            best[node] = (key, stamp)
            if node == root_key:
                break
            node = _parent_of(node)
    return best


def inode_count(
    entries: Sequence[tuple[str, int]], root: str, dirs: Sequence[str] = ()
) -> int:
    """The entries ``--inodes`` counts in an operand: every file and
    directory under it, and the operand itself.

    Args:
        entries (Sequence[tuple[str, int]]): leaf (virtual path, size).
        root (str): the operand's virtual path.
        dirs (Sequence[str]): the directories the walk met.
    """
    root_key = _norm(root)
    prefix = root_key if root_key.endswith("/") else root_key + "/"
    nodes: set[str] = set()
    for path in [leaf for leaf, _ in entries] + list(dirs):
        node = _norm(path)
        while (
            node != root_key and node.startswith(prefix) and node not in nodes
        ):
            nodes.add(node)
            node = _parent_of(node)
    return len(nodes) + 1


def _norm(path: str) -> str:
    return path.rstrip("/") or "/"


def _parent_of(path: str) -> str:
    cut = _norm(path).rfind("/")
    return path[:cut] if cut > 0 else "/"


def _depth_of(entry_path: str, base_path: str) -> int:
    base = base_path.rstrip("/")
    rel = entry_path.rstrip("/")[len(base) :]
    if not rel:
        return 0
    return rel.strip("/").count("/") + 1


def to_virtual(
    entries: Sequence[tuple[str, int]], path: PathSpec
) -> list[tuple[str, int]]:
    """Lift mount-relative walk entries onto absolute virtual paths.

    Backends walk their own key space and report mount-relative paths, so
    two mounts that both hold ``notes.txt`` would otherwise render the
    same line twice. The mount prefix is recovered from the operand the
    same way ``find`` and ``grep -r`` recover it.

    Args:
        entries (Sequence[tuple[str, int]]): mount-relative (path, size).
        path (PathSpec): the operand the entries were walked from.

    Returns:
        list[tuple[str, int]]: the pairs with absolute virtual paths.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    if not prefix:
        return list(entries)
    return [
        (prefix + "/" + entry.lstrip("/"), size) for entry, size in entries
    ]


def separate_total(entries: Sequence[tuple[str, int]], root: str) -> int:
    """Bytes of the leaves sitting directly in the operand (GNU ``-S``).

    This is the operand's own row under ``-S``, not what it contributes
    to the ``-c`` grand total: GNU keeps that recursive (coreutils 9.7,
    ``du -bSc dir`` prints ``3 dir`` then ``6 total``).

    Args:
        entries (Sequence[tuple[str, int]]): leaf (virtual path, size).
        root (str): the operand's absolute virtual path.
    """
    root_key = _norm(root)
    return sum(
        size for leaf, size in entries if _parent_of(_norm(leaf)) == root_key
    )


def rollup(
    entries: Sequence[tuple[str, int]],
    root: str,
    *,
    a: bool,
    max_depth: int | None,
    dirs: Sequence[str] = (),
    separate_dirs: bool = False,
    inodes: bool = False,
) -> list[tuple[str, int]]:
    """Derive GNU's per-directory lines from a flat list of leaf files.

    Backends report only files, but GNU ``du`` prints a line per
    directory carrying its recursive total (and, under ``-a``, a line per
    file too). Every directory between the operand and a leaf therefore
    accumulates that leaf's size, and the result is emitted post-order:
    children before their parent, siblings sorted by name. GNU walks in
    readdir order, which is unspecified, so sorting is a deterministic
    choice within the same shape.

    With ``-S``/``--separate-dirs`` a directory only counts files that
    sit directly in it: a leaf still forces every ancestor directory to
    appear (possibly at size 0), but only the immediate parent gets its
    bytes. The operand's own line is not included; the caller renders it
    with the operand as typed.

    Args:
        entries (Sequence[tuple[str, int]]): leaf (virtual path, size).
        root (str): the operand's absolute virtual path.
        a (bool): -a, keep the file lines as well as the directories.
        max_depth (int | None): drop nodes deeper than this many levels.
        dirs (Sequence[str]): paths that are directories even though no
            leaf may point at them: the directories a walk met (an empty
            one, or one it could not open) and the roots of descendant
            mounts, which still get GNU's ``0`` row.
        separate_dirs (bool): -S, exclude subdirectory sizes.
        inodes (bool): --inodes, each directory counts itself too, and
            under ``-S`` itself alone of the directories in it; the
            leaves come in as one each.

    Returns:
        list[tuple[str, int]]: (virtual path, size) in GNU's print order.
    """
    root_key = _norm(root)
    prefix = root_key if root_key.endswith("/") else root_key + "/"
    sizes: dict[str, int] = {}
    files: dict[str, int] = {}
    for leaf, size in entries:
        node = _norm(leaf)
        if node == root_key or not node.startswith(prefix):
            continue
        files[node] = size
        parent = _parent_of(node)
        immediate = True
        while parent != root_key and parent.startswith(prefix):
            if separate_dirs and not immediate:
                # -S: only the directory a file sits in counts its
                # bytes. The ancestors still print, at 0 when they hold
                # nothing but directories.
                sizes.setdefault(parent, 0)
            else:
                sizes[parent] = sizes.get(parent, 0) + size
            immediate = False
            parent = _parent_of(parent)

    # setdefault, never assignment: a hinted directory that does hold
    # leaves already carries their total.
    for hinted in dirs:
        node = _norm(hinted)
        while node != root_key and node.startswith(prefix):
            sizes.setdefault(node, 0)
            node = _parent_of(node)
    if inodes:
        # Deepest first, so each directory's count of the directories
        # in its tree is complete before it is added to its parent's.
        own = dict.fromkeys(sizes, 1)
        for node in sorted(sizes, key=lambda n: n.count("/"), reverse=True):
            parent = _parent_of(node)
            if not separate_dirs and parent in own:
                own[parent] += own[node]
        for node, count in own.items():
            sizes[node] += count

    # Keyed backends (S3, GridFS) carry a zero-byte marker object for a
    # directory, which arrives here as a leaf. Under -a it must not
    # replace that directory's computed total, so sums win on a clash.
    nodes: dict[str, int] = dict(files) if a else {}
    nodes.update(sizes)
    kids: dict[str, list[str]] = {}
    for node in nodes:
        kids.setdefault(_parent_of(node), []).append(node)
    for group in kids.values():
        group.sort()

    order: list[tuple[str, int]] = []
    stack: list[tuple[str, bool]] = [(root_key, False)]
    while stack:
        node, expanded = stack.pop()
        if expanded:
            deep = (
                max_depth is not None and _depth_of(node, root_key) > max_depth
            )
            if node != root_key and not deep:
                order.append((node, nodes[node]))
            continue
        stack.append((node, True))
        for child in reversed(kids.get(node, [])):
            stack.append((child, False))
    return order


def drop_shadowed(
    records: Sequence[PathRecord], roots: Sequence[str]
) -> list[PathRecord]:
    """Drop what falls under a descendant mount's root.

    The parent backend's keys under a nested mount are shadowed: no read
    can reach them, so no size may count them. GNU agrees (coreutils 9.7,
    ``du --apparent-size -B1`` over a tmpfs mounted inside the operand): a
    file covered by a mount appears nowhere and is in no total. What GNU
    additionally folds into the parent's rows, the mounted filesystem's
    own content, arrives here as the descendant's separately appended
    block instead, so the parent's own report is GNU's ``du -x``.

    Args:
        records (Sequence[PathRecord]): files and directories measured.
        roots (Sequence[str]): descendant mount roots, no trailing slash.
    """
    return [
        r
        for r in records
        if not any(
            _norm(r.path.virtual) == root
            or _norm(r.path.virtual).startswith(root + "/")
            for root in roots
        )
    ]


def leaves_of(records: Sequence[PathRecord]) -> list[tuple[str, int]]:
    """Each file a measurement counted, as (virtual path, bytes).

    Args:
        records (Sequence[PathRecord]): one operand's measurement.
    """
    return [(r.path.virtual, r.size) for r in records if r.size is not None]


def _row(
    size: int, flags: DuFlags, label: str, newest: Newest | None
) -> list[str]:
    """One row as ``-t`` lets it print: the line, or none.

    Args:
        size (int): the row's bytes, or its count under ``--inodes``.
        flags (DuFlags): the parsed command line.
        label (str): the name it prints under.
        newest (Newest | None): the newest time in its tree.
    """
    return [_line(size, flags, label, newest)] if _kept(size, flags) else []


async def _du_one(
    path: PathSpec,
    run: int,
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    flags: DuFlags,
    mounts: MountView | None = None,
    directories: Callable[[], Sequence[str]] | None = None,
    times: Callable[[], Mapping[str, str]] | None = None,
) -> tuple[list[str], int, list[PathRecord] | None, Newest | None]:
    label = path.raw_path
    root_key = _norm(path.virtual)
    roots = mounts.descendants(path.virtual) if mounts is not None else []
    timed = times is not None and flags.time is not None

    if (
        flags.s
        and not flags.S
        and not flags.inodes
        and not roots
        and not paths_scoped([path])
    ):
        # The one-total fast path trusts the backend's own sum, which a
        # session hiding paths under this operand cannot: hidden leaves
        # would be counted into a total their names never justify, so
        # that session takes the entries walk below instead; a path
        # rule likewise, since the walk is where a refused directory is
        # reported. Per operand: a hide elsewhere keeps this total.
        total = await compute_size(path)
        newest = (
            newest_under(times(), path.virtual).get(root_key)
            if times is not None and timed
            else None
        )
        return _row(total, flags, label, newest), total, None, newest

    entries, total = await compute_entries(path)
    raw = times() if times is not None and timed else {}
    stamps = newest_under(raw, path.virtual) if raw else {}
    newest = stamps.get(root_key)
    under = root_key.rstrip("/") + "/"
    met = drop_shadowed(
        [
            PathRecord(PathSpec.from_str_path(d), run, modified=raw.get(d))
            for d in (directories() if directories is not None else ())
            if _norm(d).startswith(under)
        ],
        roots,
    )
    walked = directories is not None and any(
        _norm(d) == root_key for d in directories()
    )
    own_record = PathRecord(path, run, modified=raw.get(path.virtual))
    if not entries and not met and not walked:
        # A backend that can only produce a size degrades to one total;
        # it cannot enumerate, so shadowed keys cannot be excluded either.
        # A walk that opened the operand already said all it can: an
        # empty directory, or one a rule refused, which a second walk
        # would report twice.
        total = await compute_size(path)
        count = 1 if flags.inodes else total
        return (
            _row(count, flags, label, newest),
            count,
            [own_record] if total == 0 else None,
            newest,
        )

    counted = [
        PathRecord(
            PathSpec.from_str_path(leaf), run, size, modified=raw.get(leaf)
        )
        for leaf, size in to_virtual(entries, path)
    ]
    # Shadowed leaves drop: the total is the sum of what survived, never
    # the backend's own number.
    kept = drop_shadowed(counted, roots)
    virtual = leaves_of(kept)
    if len(kept) != len(counted) or roots:
        total = sum(size for _, size in virtual)
    dirs = [r.path.virtual for r in met]
    records = [own_record, *kept, *met]
    if flags.inodes:
        total = inode_count(virtual, path.virtual, dirs)
    # A file operand walks to itself. GNU prints it once, with or
    # without -a, never as a leaf line plus a roll-up line. GNU scopes
    # -S to directories, so a file operand keeps its own size in both
    # its row and the grand total.
    if len(virtual) == 1 and _norm(virtual[0][0]) == root_key:
        size = total if flags.inodes else virtual[0][1]
        return _row(size, flags, label, newest), total, records, newest
    counts = [(leaf, 1) for leaf, _ in virtual] if flags.inodes else virtual
    # -S changes what the operand's own row counts, not what the operand
    # contributes to -c: GNU's grand total stays recursive (coreutils
    # 9.7, `du -bSc dir` prints `3 dir` then `6 total`).
    own = (
        separate_total(counts, path.virtual) + int(flags.inodes)
        if flags.S
        else total
    )
    if flags.s:
        return _row(own, flags, label, newest), total, records, newest

    rows = rollup(
        counts,
        path.virtual,
        a=flags.a,
        max_depth=flags.max_depth,
        dirs=dirs,
        separate_dirs=flags.S,
        inodes=flags.inodes,
    )
    shown = respell_raw([node for node, _ in rows], path.virtual, label)
    lines = [
        line
        for name, (node, size) in zip(shown, rows)
        for line in _row(size, flags, name, stamps.get(node))
    ]
    lines.extend(_row(own, flags, label, newest))
    return lines, total, records, newest


async def du(
    paths: list[PathSpec],
    *,
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    flags: DuFlags,
    missing: Sequence[tuple[str, str, int]] = (),
    stopped: Callable[[], Sequence[str]] | None = None,
    mounts: MountView | None = None,
    unreadable: Callable[[], Sequence[str]] | None = None,
    directories: Callable[[], Sequence[str]] | None = None,
    inaccessible: Callable[[], Sequence[tuple[str, str | None]]] | None = None,
    repeated: Callable[[PathSpec], bool] | None = None,
    times: Callable[[], Mapping[str, str]] | None = None,
) -> DuOutput:
    """Render ``du`` output for a list of operands.

    Args:
        paths (list[PathSpec]): the readable operands, glob-resolved.
        compute_size (ComputeSize): recursive byte size of one operand.
        compute_entries (ComputeEntries): per-file breakdown of one
            operand as mount-relative (path, size) pairs plus the total.
            ``None`` on backends that can only produce a size, which makes
            both ``-a`` and the per-directory lines degrade to one total.
        flags (DuFlags): the parsed command line.
        missing (Sequence[tuple[str, str, int]]): operands that could
            not be read, as typed, with the strerror and how many readable
            operands came before each. GNU reports each where it stood
            and exits 1 but still prints the rest.
        stopped (Callable[[], Sequence[str]] | None): read after the
            walks for where one ran past ``walk_limit``, each line
            without the command's name.
        mounts (MountView | None): where the mount boundaries are; leaves
            under a descendant mount's root are shadowed and dropped from
            every row and total (see ``drop_shadowed``).
        unreadable (Callable[[], Sequence[str]] | None): read after the
            walks for the directories a walk could not open (a rule
            refused them below the operand). GNU names each one,
            counts what it could, and exits 1; the line is spelled as
            the operand was typed, and follows the unreadable-operand
            lines since those are known before any walk.
        directories (Callable[[], Sequence[str]] | None): read after each
            operand's walk for every directory it met, so one no file
            points at (empty, or refused) still gets GNU's row.
        inaccessible (Callable[[], Sequence[tuple[str, str | None]]] |
            None): read after the walks for each link ``-L`` could not
            follow, with the strerror GNU adds for a chain that loops
            (it names a dangling one alone); exits 1.
        repeated (Callable[[PathSpec], bool] | None): asked before each
            operand's walk whether an earlier one already counted it,
            which GNU then skips without a row.
        times (Callable[[], Mapping[str, str]] | None): read after each
            operand's walk for the time of every entry it met, by virtual
            path, under ``--time``.
    """
    lines: list[str] = []
    totals: list[int] = []
    records: list[PathRecord] | None = []
    latest: Newest | None = None
    notes: list[tuple[int, str]] = []
    if flags.warning:
        notes.append((0, flags.warning))
    exit_code = 1 if missing else 0
    left = list(missing)
    said_unreadable = said_inaccessible = 0
    for run, path in enumerate(paths):
        while left and left[0][2] <= run:
            notes.append((len(lines), _unread_operand(*left.pop(0)[:2])))
        if repeated is not None and repeated(path):
            continue
        block, total, measured, newest = await _du_one(
            path,
            run,
            compute_size,
            compute_entries,
            flags,
            mounts,
            directories,
            times,
        )
        # What a walk could not open GNU names as it goes, before the
        # rows it prints once it is done there.
        unread = list(unreadable()) if unreadable is not None else []
        for virtual in unread[said_unreadable:]:
            notes.append(
                (
                    len(lines),
                    f"du: cannot read directory "
                    f"'{_respell_under(virtual, paths)}': "
                    f"{posix_phrase(FsCondition.EACCES)}",
                )
            )
            exit_code = 1
        said_unreadable = len(unread)
        lost = list(inaccessible()) if inaccessible is not None else []
        for virtual, detail in lost[said_inaccessible:]:
            shown = _respell_under(virtual, paths)
            notes.append(
                (
                    len(lines),
                    f"du: cannot access '{shown}'"
                    + (f": {detail}" if detail is not None else ""),
                )
            )
            exit_code = 1
        said_inaccessible = len(lost)
        lines.extend(block)
        totals.append(total)
        if newest is not None and (latest is None or newest[0] > latest[0]):
            latest = newest
        if measured is None:
            records = None
        elif records is not None:
            records.extend(measured)
    notes.extend(
        (len(lines), _unread_operand(raw, why)) for raw, why, _ in left
    )
    # GNU still prints the grand total when every operand failed ("0
    # total"), so this stays outside the loop guard.
    if flags.c:
        lines.append(_line(sum(totals), flags, "total", latest))
    for line in stopped() if stopped is not None else ():
        notes.append((len(lines), f"du: {line}"))
        exit_code = 1
    rows = (
        [encode_text(line) + b"\0" for line in lines]
        if flags.null
        else [format_records([line]) for line in lines]
    )
    starts = [0]
    for row in rows:
        starts.append(starts[-1] + len(row))
    placed = [(starts[row], encode_text(f"{text}\n")) for row, text in notes]
    stderr = b"".join(line for _, line in placed)
    return DuOutput(b"".join(rows), stderr, exit_code, records, placed)


def _unread_operand(raw: str, detail: str) -> str:
    """GNU's line for an operand du could not read.

    Args:
        raw (str): the operand as typed.
        detail (str): the strerror.
    """
    if raw == "":
        return f"du: {ZERO_LENGTH_NAME}"
    return f"du: cannot access '{raw}': {detail}"


def _respell_under(virtual: str, paths: Sequence[PathSpec]) -> str:
    """Spell a walked path as the operand it lies under was typed.

    Args:
        virtual (str): the absolute virtual path the walk reached.
        paths (Sequence[PathSpec]): the operands, as parsed.
    """
    for path in paths:
        base = path.virtual.rstrip("/") or "/"
        if virtual == base or virtual.startswith(base.rstrip("/") + "/"):
            return respell_raw([virtual], path.virtual, path.raw_path)[0]
    return virtual


async def du_generic(
    flags: DuFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    stopped: Callable[[], Sequence[str]] | None = None,
    unreadable: Callable[[], Sequence[str]] | None = None,
    directories: Callable[[], Sequence[str]] | None = None,
    inaccessible: Callable[[], Sequence[tuple[str, str | None]]] | None = None,
    repeated: Callable[[PathSpec], bool] | None = None,
    times: Callable[[], Mapping[str, str]] | None = None,
) -> tuple[ByteSource, IOResult]:
    """Run one whole ``du`` invocation over flags already read
    (``read_flags``), to rendered bytes.

    Every caller needs the same steps in the same order: split the
    operands into readable and unreadable, then render. Keeping them here
    means a backend wrapper is wiring only, and the steps cannot drift
    apart per backend. The wrapper reads the flags first, since its walk
    leaves out what ``--exclude`` and ``-X`` match.

    The walks meet links as entries of their own; under -L they follow
    them instead, which the operand's own was already, at dispatch.
    Deliberate divergence: a link counts as its target string's length,
    the size ``ls -l`` prints, where GNU counts the disk blocks it holds
    (0 for a target short enough to live in the inode); mirage counts
    bytes throughout.

    ``--apparent-size`` preserves the existing apparent-byte measurement;
    only explicit unit options change its scale. ``-l`` counts a file
    once per hard link to it, and no backend here has hard links, so it
    changes nothing.

    Args:
        flags (DuFlags): The options, read before the operands were.
        paths (list[PathSpec]): The operands as parsed, possibly empty.
        texts (list[str]): Non-path words, unused by du.
        ctx (Context): Flags and cwd from the dispatcher.
        resolve_glob (Callable[[list[PathSpec]], Awaitable[list[PathSpec]]]):
            Expands globs against the backend.
        stat (Callable[[PathSpec], Awaitable[FileStat]]):
            Raises when an operand cannot be read.
        compute_size (ComputeSize): Recursive byte size of one operand.
        compute_entries (ComputeEntries): Per-file breakdown.
        stopped (Callable[[], Sequence[str]] | None): Where a walk ran
            past ``walk_limit``.
        unreadable (Callable[[], Sequence[str]] | None): The directories
            the walk could not open, read after the walks.
        directories (Callable[[], Sequence[str]] | None): Every directory
            the walk met, read after each operand's walk.
        inaccessible (Callable[[], Sequence[tuple[str, str | None]]] |
            None): The links -L could not follow, read after the walks.
        repeated (Callable[[PathSpec], bool] | None): Whether an earlier
            operand's walk already counted an operand.
        times (Callable[[], Mapping[str, str]] | None): Each entry's time
            the walks met, under ``--time``.

    """
    present, missing = await du_operands(
        paths,
        ctx.cwd,
        resolve_glob,
        stat,
        partial(du_has_content, compute_entries),
        stat_path=vfs_stat_path(ctx.vfs),
        excludes=flags.excludes,
    )
    out = await du(
        present,
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=flags,
        missing=missing,
        stopped=stopped,
        unreadable=unreadable,
        directories=directories,
        mounts=mounts_of(ctx),
        inaccessible=inaccessible,
        repeated=repeated,
        times=times,
    )
    io = IOResult(exit_code=out.exit_code, records=out.records)
    return at_offsets(out.stdout, out.notes, io), io


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A du line reads below every path it names, walks into the mounts
    below unless ``-x``, and follows a link operand when the last of
    ``-L``, ``-P``, ``-D`` and ``-H`` is not ``-P``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(
        follows=(
            Follow.LAST
            if fl.typed_order(
                "dereference", "no_dereference", "dereference_args", "H"
            )[-1:]
            not in ([], ["no_dereference"])
            else Follow.NONE
        ),
        walks=not fl.as_bool("one_file_system"),
        reads_subtree=True,
    )

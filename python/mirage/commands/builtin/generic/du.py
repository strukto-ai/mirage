import logging
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.context import hidden_paths_active, path_allowed
from mirage.io.types import IOResult
from mirage.ops.types import LinkView, MountView, StatPath
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import respell_raw

logger = logging.getLogger(__name__)

DuEntries = tuple[list[tuple[str, int]], int]
ComputeSize = Callable[[PathSpec], Awaitable[int]]
ComputeEntries = Callable[[PathSpec], Awaitable[DuEntries]]

DEFAULT_MAX_DU_ENTRIES = 10000
USAGE_HINT = "Try 'du --help' for more information."
_DEPTH_HEX = re.compile(r"^[+-]?0[xX][0-9a-fA-F]+$")
_DEPTH_OCT = re.compile(r"^[+-]?0[0-7]*$")
_DEPTH_DEC = re.compile(r"^[+-]?[1-9][0-9]*$")


@dataclass(frozen=True, slots=True)
class DuFlags:
    """Parsed ``du`` command line.

    Args:
        s (bool): -s, one total per operand and no subtree lines.
        a (bool): -a, list files as well as directories.
        h (bool): -h, human-readable sizes.
        c (bool): -c, append a grand total.
        S (bool): -S/--separate-dirs, directories exclude subdirectory sizes.
        max_depth (int | None): --max-depth/-d, deepest level to print.
        warning (str | None): a non-fatal diagnostic GNU prints before the
            output, without failing the command.
    """

    s: bool = False
    a: bool = False
    h: bool = False
    c: bool = False
    S: bool = False
    max_depth: int | None = None
    warning: str | None = None


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
    """

    stdout: bytes
    stderr: bytes
    exit_code: int


def parse_depth(text: str) -> int | None:
    """Read a ``--max-depth`` value the way GNU's ``xstrtoul`` does.

    That is C ``strtoul`` with base 0: a ``0x`` prefix is hexadecimal, a
    bare leading ``0`` is octal (so ``010`` is 8 and ``09`` is invalid),
    anything else is decimal. Surrounding whitespace is not allowed and
    neither are Python's own ``int`` conveniences (``1_0``, non-ASCII
    digits), which GNU rejects.

    Args:
        text (str): the raw flag value.

    Returns:
        int | None: the depth, or None if the text is not a number.
    """
    if _DEPTH_HEX.match(text):
        return int(text, 16)
    if _DEPTH_OCT.match(text):
        return int(text, 8)
    if _DEPTH_DEC.match(text):
        return int(text, 10)
    return None


def parse_flags(*,
                s: bool,
                a: bool,
                h: bool,
                c: bool,
                max_depth: str | None,
                separate_dirs: bool = False) -> DuFlags:
    """Validate a ``du`` command line the way GNU does, before any I/O.

    GNU parses ``--max-depth`` as each option is read, so a bad depth is
    reported ahead of the mutually-exclusive checks that run once the
    whole line is parsed. All three exit 1, du's usage-error code.

    Args:
        s (bool): -s.
        a (bool): -a.
        h (bool): -h.
        c (bool): -c.
        max_depth (str | None): raw --max-depth/-d text, unparsed.
        separate_dirs (bool): -S/--separate-dirs.

    Raises:
        UsageError: on a bad depth or a conflicting combination.
    """
    depth: int | None = None
    if max_depth is not None:
        depth = parse_depth(max_depth)
        if depth is None:
            raise UsageError(
                f"du: invalid maximum depth '{max_depth}'\n{USAGE_HINT}", 1)
    if s and a:
        raise UsageError(
            f"du: cannot both summarize and show all entries\n{USAGE_HINT}", 1)
    warning: str | None = None
    if s and depth is not None:
        # GNU treats -s and --max-depth=0 as the same request, so it warns
        # and carries on; any other depth is a real conflict and exits 1.
        if depth != 0:
            raise UsageError(
                "du: warning: summarizing conflicts with "
                f"--max-depth={depth}\n{USAGE_HINT}", 1)
        warning = ("du: warning: summarizing is the same as using "
                   "--max-depth=0")
    return DuFlags(s=s,
                   a=a,
                   h=h,
                   c=c,
                   S=separate_dirs,
                   max_depth=depth,
                   warning=warning)


def cwd_spec(cwd: PathSpec | str) -> PathSpec:
    """Build the operand GNU ``du`` assumes when the line names none.

    Args:
        cwd (PathSpec | str): the session's working directory.
    """
    if isinstance(cwd, PathSpec):
        return cwd
    return PathSpec(virtual=cwd,
                    directory=cwd,
                    resolved=False,
                    resource_path=cwd.strip("/"))


async def du_operands(
    paths: list[PathSpec],
    cwd: PathSpec | str,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    has_content: Callable[[PathSpec], Awaitable[bool]] | None = None,
    links: LinkView | None = None,
    stat_path: StatPath | None = None,
) -> tuple[list[PathSpec], list[str]]:
    """Split the operands into the ones du can read and the ones it cannot.

    GNU names every operand it fails to stat, keeps going with the rest,
    and exits 1. With no operand at all it measures the working
    directory.

    A failed stat is not proof of absence, and du runs bound to one
    backend, so its own stat cannot see two things that make a path a
    real directory: a mount nested below it and a symlink below it are
    both namespace state, held in another resource or in no resource at
    all. ``stat_path`` is the channel that knows, because it resolves
    through the dispatcher rather than one accessor, and it is the same
    probe ``find`` classifies its start point with. Session filtering
    rides along with it: a mount the session may not see contributes no
    directory here, so absence stays the answer for it.

    ``has_content`` is the last resort behind that, for a backend that
    never materialises a directory entry for its own mount root (redis is
    one) while the subtree below it is full.

    Args:
        paths (list[PathSpec]): the operands as parsed, possibly empty.
        cwd (PathSpec | str): the working directory, used when empty.
        resolve_glob (Callable): expands globs against the backend.
        stat (Callable): raises when an operand cannot be read.
        has_content (Callable | None): asked only when stat failed, to
            tell an implicit directory from an absent path.
        links (LinkView | None): the namespace's symlink facts. A link
            has no backend inode, so it fails stat while still being a
            perfectly readable operand.
        stat_path (StatPath | None): dispatcher-backed stat, None when du
            runs outside a workspace and there is no namespace to ask.

    Returns:
        tuple[list[PathSpec], list[str]]: readable operands, then the
        as-typed spelling of each unreadable one.
    """
    targets = paths if paths else [cwd_spec(cwd)]
    resolved = await resolve_glob(targets)
    present: list[PathSpec] = []
    missing: list[str] = []
    if not resolved:
        # An unmatched glob reaches GNU as the literal pattern, which it
        # then reports as unreadable.
        missing = [p.raw_path for p in targets]
    for path in resolved:
        if links is not None and links.stat_at(path.virtual) is not None:
            present.append(path)
            continue
        try:
            await stat(path)
        except (FileNotFoundError, ValueError):
            probed: FileStat | None = None
            if stat_path is not None:
                probed = await stat_path(path.virtual)
            if probed is None and (has_content is None
                                   or not await has_content(path)):
                missing.append(path.raw_path)
                continue
        present.append(path)
    return present, missing


async def du_has_content(compute_entries: ComputeEntries,
                         path: PathSpec) -> bool:
    """Whether an operand holds anything, for the unstattable case.

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


def _format_size(size: int, human: bool) -> str:
    return _human_size(size) if human else str(size)


def _line(size: int, human: bool, label: str) -> str:
    return _format_size(size, human) + "\t" + label


def _norm(path: str) -> str:
    return path.rstrip("/") or "/"


def _parent(path: str) -> str:
    cut = _norm(path).rfind("/")
    return path[:cut] if cut > 0 else "/"


def _depth(entry_path: str, base_path: str) -> int:
    base = base_path.rstrip("/")
    rel = entry_path.rstrip("/")[len(base):]
    if not rel:
        return 0
    return rel.strip("/").count("/") + 1


def to_virtual(entries: Sequence[tuple[str, int]],
               path: PathSpec) -> list[tuple[str, int]]:
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
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    if not prefix:
        return list(entries)
    return [(prefix + "/" + entry.lstrip("/"), size)
            for entry, size in entries]


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
    return sum(size for leaf, size in entries
               if _parent(_norm(leaf)) == root_key)


def rollup(
    entries: Sequence[tuple[str, int]],
    root: str,
    *,
    a: bool,
    max_depth: int | None,
    dirs: Sequence[str] = (),
    separate_dirs: bool = False,
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
            leaf points at them. mirage cannot otherwise see an empty
            directory, so this is the one case it can: an empty mount
            still gets GNU's ``0`` row.
        separate_dirs (bool): -S, exclude subdirectory sizes.

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
        parent = _parent(node)
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
            parent = _parent(parent)

    # setdefault, never assignment: a hinted directory that does hold
    # leaves already carries their total.
    for hinted in dirs:
        node = _norm(hinted)
        while node != root_key and node.startswith(prefix):
            sizes.setdefault(node, 0)
            node = _parent(node)

    # Keyed backends (S3, GridFS) carry a zero-byte marker object for a
    # directory, which arrives here as a leaf. Under -a it must not
    # replace that directory's computed total, so sums win on a clash.
    nodes: dict[str, int] = dict(files) if a else {}
    nodes.update(sizes)
    kids: dict[str, list[str]] = {}
    for node in nodes:
        kids.setdefault(_parent(node), []).append(node)
    for group in kids.values():
        group.sort()

    order: list[tuple[str, int]] = []
    stack: list[tuple[str, bool]] = [(root_key, False)]
    while stack:
        node, expanded = stack.pop()
        if expanded:
            deep = max_depth is not None and _depth(node, root_key) > max_depth
            if node != root_key and not deep:
                order.append((node, nodes[node]))
            continue
        stack.append((node, True))
        for child in reversed(kids.get(node, [])):
            stack.append((child, False))
    return order


def drop_shadowed(entries: Sequence[tuple[str, int]],
                  roots: Sequence[str]) -> list[tuple[str, int]]:
    """Drop leaves that fall under a descendant mount's root.

    The parent backend's keys under a nested mount are shadowed: no read
    can reach them, so no size may count them. GNU agrees (coreutils 9.7,
    ``du --apparent-size -B1`` over a tmpfs mounted inside the operand): a
    file covered by a mount appears nowhere and is in no total. What GNU
    additionally folds into the parent's rows, the mounted filesystem's
    own content, arrives here as the descendant's separately appended
    block instead, so the parent's own report is GNU's ``du -x``.

    Args:
        entries (Sequence[tuple[str, int]]): leaf (virtual path, size).
        roots (Sequence[str]): descendant mount roots, no trailing slash.
    """
    kept: list[tuple[str, int]] = []
    for leaf, size in entries:
        node = _norm(leaf)
        if any(node == root or node.startswith(root + "/") for root in roots):
            continue
        kept.append((leaf, size))
    return kept


def link_leaves(links: LinkView | None, root: str) -> list[tuple[str, int]]:
    """Symlinks under an operand as du leaf entries.

    Links live in the namespace, so neither a backend's native du op nor
    a readdir walk reports them. Merging here, above that fork, is what
    keeps a backend with a native op and one without from disagreeing.

    Deliberate divergence: GNU sizes a symlink at 0 because it counts
    disk blocks and a short target is stored inside the inode. mirage
    counts bytes throughout (an object store has no block size), so a
    link counts as its target string's length, the same number ``ls -l``
    prints for it.

    Args:
        links (LinkView | None): the namespace's symlink facts.
        root (str): the operand's absolute virtual path.
    """
    if links is None:
        return []
    return [(path, st.size or 0) for path, st in links.subtree(root)]


async def _du_one(
    path: PathSpec,
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    flags: DuFlags,
    links: LinkView | None = None,
    mounts: MountView | None = None,
) -> tuple[list[str], int]:
    label = path.raw_path

    link_row = links.stat_at(path.virtual) if links is not None else None
    if link_row is not None:
        # GNU du does not follow a symlink operand without -L; the
        # operand is the link, and it accounts for the link alone.
        size = link_row.size or 0
        return [_line(size, flags.h, label)], size

    roots = mounts.descendants(path.virtual) if mounts is not None else []
    leaves = link_leaves(links, path.virtual)
    if roots:
        leaves = drop_shadowed(leaves, roots)
    link_total = sum(size for _, size in leaves)

    if flags.s and not flags.S and not roots and not hidden_paths_active():
        # The one-total fast path trusts the backend's own sum, which a
        # session hiding paths cannot: hidden leaves would be counted
        # into a total their names never justify, so that session takes
        # the entries walk below instead.
        total = await compute_size(path) + link_total
        return [_line(total, flags.h, label)], total

    entries, total = await compute_entries(path)
    total += link_total
    if not entries and not leaves:
        # A backend that can only produce a size degrades to one total;
        # it cannot enumerate, so shadowed keys cannot be excluded either.
        total = await compute_size(path)
        return [_line(total, flags.h, label)], total

    virtual = to_virtual(entries, path) + leaves
    visible = [(leaf, size) for leaf, size in virtual if path_allowed(leaf)]
    if len(visible) != len(virtual):
        # Same honesty rule as shadowed leaves: the total is the sum of
        # what the session may see, never the backend's own number.
        virtual = visible
        total = sum(size for _, size in virtual)
    if roots:
        # The backend's own total counted the shadowed leaves, so the
        # honest number is the sum of what survived.
        virtual = drop_shadowed(virtual, roots)
        total = sum(size for _, size in virtual)
    root_key = _norm(path.virtual)
    # A file operand walks to itself. GNU prints it once, with or
    # without -a, never as a leaf line plus a roll-up line. GNU scopes
    # -S to directories, so a file operand keeps its own size in both
    # its row and the grand total.
    if len(virtual) == 1 and _norm(virtual[0][0]) == root_key:
        return [_line(virtual[0][1], flags.h, label)], total
    # -S changes what the operand's own row counts, not what the operand
    # contributes to -c: GNU's grand total stays recursive (coreutils
    # 9.7, `du -bSc dir` prints `3 dir` then `6 total`).
    own = separate_total(virtual, path.virtual) if flags.S else total
    if flags.s:
        return [_line(own, flags.h, label)], total

    rows = rollup(virtual,
                  path.virtual,
                  a=flags.a,
                  max_depth=flags.max_depth,
                  separate_dirs=flags.S)
    shown = respell_raw([node for node, _ in rows], path.virtual, label)
    lines = [
        _line(size, flags.h, name) for name, (_, size) in zip(shown, rows)
    ]
    lines.append(_line(own, flags.h, label))
    return lines, total


async def run_du(
    paths: list[PathSpec],
    cwd: PathSpec | str,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    *,
    s: bool = False,
    a: bool = False,
    h: bool = False,
    c: bool = False,
    max_depth: str | None = None,
    separate_dirs: bool = False,
    truncated: Callable[[], bool] | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    stat_path: StatPath | None = None,
) -> DuOutput:
    """Run one whole ``du`` invocation, from raw flags to rendered bytes.

    Every caller needs the same three steps in the same order: validate
    the flags before touching I/O, split the operands into readable and
    unreadable, then render. Keeping them here means a backend wrapper is
    wiring only, and the three steps cannot drift apart per backend.

    Args:
        paths (list[PathSpec]): the operands as parsed, possibly empty.
        cwd (PathSpec | str): working directory, measured when empty.
        resolve_glob (Callable): expands globs against the backend.
        stat (Callable): raises when an operand cannot be read.
        compute_size (ComputeSize): recursive byte size of one operand.
        compute_entries (ComputeEntries): per-file breakdown.
        s (bool): -s.
        a (bool): -a.
        h (bool): -h.
        c (bool): -c.
        max_depth (str | None): raw --max-depth text.
        separate_dirs (bool): -S/--separate-dirs.
        truncated (Callable[[], bool] | None): whether a walk was cut off.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are, so
            keys shadowed by a nested mount are excluded from every row
            and total.
        stat_path (StatPath | None): dispatcher-backed stat, which is what
            answers for a directory the bound backend cannot see.

    Raises:
        UsageError: on a bad depth or a conflicting flag combination.
    """
    flags = parse_flags(s=s,
                        a=a,
                        h=h,
                        c=c,
                        max_depth=max_depth,
                        separate_dirs=separate_dirs)
    present, missing = await du_operands(paths,
                                         cwd,
                                         resolve_glob,
                                         stat,
                                         partial(du_has_content,
                                                 compute_entries),
                                         links=links,
                                         stat_path=stat_path)
    return await du(present,
                    compute_size=compute_size,
                    compute_entries=compute_entries,
                    flags=flags,
                    missing=missing,
                    truncated=truncated,
                    links=links,
                    mounts=mounts)


async def du(
    paths: list[PathSpec],
    *,
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    flags: DuFlags,
    missing: Sequence[str] = (),
    truncated: Callable[[], bool] | None = None,
    links: LinkView | None = None,
    mounts: MountView | None = None,
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
        missing (Sequence[str]): operands that could not be read, as
            typed. GNU reports each and exits 1 but still prints the rest.
        truncated (Callable[[], bool] | None): read after the walks to ask
            whether any of them hit its entry cap.
        links (LinkView | None): the namespace's symlink facts, merged
            into every operand's leaf list.
        mounts (MountView | None): where the mount boundaries are; leaves
            under a descendant mount's root are shadowed and dropped from
            every row and total (see ``drop_shadowed``).
    """
    lines: list[str] = []
    totals: list[int] = []
    for path in paths:
        block, total = await _du_one(path, compute_size, compute_entries,
                                     flags, links, mounts)
        lines.extend(block)
        totals.append(total)
    # GNU still prints the grand total when every operand failed ("0
    # total"), so this stays outside the loop guard.
    if flags.c:
        lines.append(_line(sum(totals), flags.h, "total"))

    notes = [flags.warning] if flags.warning else []
    notes.extend(f"du: cannot access '{raw}': No such file or directory"
                 for raw in missing)
    exit_code = 1 if missing else 0
    if truncated is not None and truncated():
        notes.append("du: walk stopped early: the reported sizes are "
                     "incomplete")
        exit_code = 1
    stderr = ("\n".join(notes) + "\n").encode() if notes else b""
    return DuOutput(format_records(lines), stderr, exit_code)


async def du_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    resolve_glob: Callable[[list[PathSpec]], Awaitable[list[PathSpec]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    compute_size: ComputeSize,
    compute_entries: ComputeEntries,
    truncated: Callable[[], bool] | None = None,
) -> tuple[bytes, IOResult]:
    """Run du over the given operands; mirrors duGeneric.

    The wiring binds the backend ops (native du or the readdir walk plus
    its budget); flag semantics live here. -L dereferences: the operand
    was already rewritten at dispatch, and withholding the link table
    stops the links below it from being counted as entries in their own
    right, which is what GNU does (it follows each one and finds the
    target already accounted for). A link pointing outside the operand's
    own subtree is undercounted; GNU would traverse into it.

    Args:
        paths (list[PathSpec]): The operands as parsed, possibly empty.
        texts (list[str]): Non-path words, unused by du.
        opts (CommandOpts): Flags and cwd from the dispatcher.
        resolve_glob (Callable): Expands globs against the backend.
        stat (Callable): Raises when an operand cannot be read.
        compute_size (ComputeSize): Recursive byte size of one operand.
        compute_entries (ComputeEntries): Per-file breakdown.
        truncated (Callable[[], bool] | None): Whether the walk was cut.
    """
    fl = FlagView(opts.flags, spec=SPECS["du"])
    out = await run_du(
        paths,
        opts.cwd,
        resolve_glob,
        stat,
        compute_size,
        compute_entries,
        s=fl.as_bool("s"),
        a=fl.as_bool("a"),
        h=fl.as_bool("h"),
        c=fl.as_bool("c"),
        max_depth=fl.as_str("max_depth"),
        separate_dirs=fl.as_bool("separate_dirs"),
        truncated=truncated,
        links=(None if fl.as_bool("L") else
               opts.ns.links if opts.ns is not None else None),
        mounts=opts.ns.mounts if opts.ns is not None else None,
        stat_path=opts.stat_path,
    )
    return out.stdout, IOResult(stderr=out.stderr, exit_code=out.exit_code)

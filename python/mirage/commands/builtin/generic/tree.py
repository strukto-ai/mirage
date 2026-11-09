import json
import logging
import posixpath
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from functools import partial
from typing import Literal

from mirage.commands.builtin.generic.ls import sort_by_version
from mirage.commands.builtin.utils.formatting import (
    ls_mode_string,
    styled_time,
)
from mirage.commands.builtin.utils.links import links_of, mounts_of
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.paths import vfs_readdir_path, vfs_stat_path
from mirage.commands.builtin.utils.tree import WalkBudget
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import MISS_ERRORS, WALK_ERRORS
from mirage.errors.fs import enoent
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.glob import AnyTailMatcher, any_tail_matcher
from mirage.rs.scan import refused, scan
from mirage.shell.bytes import encode_text
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    LineFacts,
    PathSpec,
    ReaddirFn,
    ReadStreamFn,
    StatFn,
)
from mirage.utils.dates import iso_timestamp
from mirage.utils.fnmatch import fnmatch
from mirage.utils.stat_view import content_size, posix_mode
from mirage.view.types import (
    LinkTargetStat,
    LinkView,
    MountView,
    ReaddirPath,
    StatPath,
)

logger = logging.getLogger(__name__)

# GNU tree's ASCII (C-locale) drawing set, matching `tree` in the battery's
# docker oracle; the vertical/indent continuations are 4 columns wide.
_BRANCH = "|-- "
_LAST = "`-- "
_VERTICAL = "|   "
_INDENT = "    "

UNOPENABLE_MARK = "  [error opening dir]"


TreeSort = Literal["name", "version", "size", "mtime", "ctime", "none"]

# The orders --sort names, and the one each shorthand asks for.
_SORTS: tuple[TreeSort, ...] = (
    "name",
    "version",
    "size",
    "mtime",
    "ctime",
    "none",
)
_SHORTHANDS: dict[str, TreeSort] = {"t": "mtime", "v": "version", "U": "none"}


@dataclass(frozen=True, slots=True)
class TreeFlags:
    """tree's line, parsed: what the walk draws, in what order, and what
    each line shows."""

    max_depth: int | None = None
    show_hidden: bool = False
    ignore_pattern: str | None = None
    dirs_only: bool = False
    match_pattern: str | None = None
    one_file_system: bool = False
    full_path: bool = False
    no_indent: bool = False
    sizes: bool = False
    dates: bool = False
    perms: bool = False
    classify: bool = False
    sort: TreeSort = "name"
    reverse: bool = False
    dirs_first: bool = False
    no_report: bool = False
    du: bool = False
    prune: bool = False
    gitignore: bool = False
    file_limit: int | None = None
    json: bool = False


async def _cross_readdir(
    readdir_path: ReaddirPath, path: PathSpec, limit: int | None = None
) -> list[str]:
    """List a directory that belongs to another mount, which indexes its
    own listing inside the dispatched op; the listing is whole, whatever
    the walk's ``limit``.

    Args:
        readdir_path (ReaddirPath): dispatcher-backed readdir.
        path (PathSpec): the directory to list.
        limit (int | None): the walk's limit, which a whole listing meets.
    """
    return await readdir_path(path.virtual)


async def _not_crossed(path: PathSpec, limit: int | None = None) -> list[str]:
    """List a mount point ``-x`` keeps the walk out of: empty, the way
    GNU tree draws a directory on another filesystem.

    Args:
        path (PathSpec): the mount point.
        limit (int | None): the walk's limit, which an empty listing meets.
    """
    return []


async def _cross_stat(stat_path: StatPath, path: PathSpec) -> FileStat:
    """Stat an entry that belongs to another mount.

    Args:
        stat_path (StatPath): dispatcher-backed stat.
        path (PathSpec): the entry to stat.
    """
    stat = await stat_path(path)
    if stat is None:
        raise enoent(path.virtual)
    return stat


async def _mount_row(
    flags: TreeFlags, cross_stat: StatFn | None, spec: PathSpec
) -> FileStat:
    """A mount root's row. The mount table already says it is a directory,
    and the backend serving it may not stat its own root (an empty mount,
    or a prefix store with no marker object), so only -p and -D, which
    print from the row, ask for the real one.

    Args:
        flags (TreeFlags): the options.
        cross_stat (StatFn | None): stat through the dispatcher.
        spec (PathSpec): the mount root.
    """
    name = posixpath.basename(spec.virtual.rstrip("/"))
    row = FileStat(name=name, type=FileType.DIRECTORY)
    if cross_stat is None or not (flags.perms or flags.dates):
        return row
    try:
        found = await cross_stat(spec)
    except WALK_ERRORS as exc:
        logger.debug("tree: no row for mount %s: %s", spec.virtual, exc)
        return row
    return replace(found, name=name, type=FileType.DIRECTORY)


def _child_mounts(mounts: MountView | None, directory: str) -> list[str]:
    """The mount roots mounted directly on this directory.

    A mount point need not exist in the parent backend at all, and when
    it does the parent lists a directory whose contents belong to
    somebody else. Either way the name has to come from the mount table,
    the same way `ls` injects it.

    A crossing entry's row is drawn from the mount table alone: it is
    synthesized as a directory without asking any backend, so the
    dispatcher never gets the chance to refuse it. `tree` names the
    boundary rather than avoiding it, so it reads the visible list; `du`
    reads the other one from the same view, because there a hidden mount
    still shadows the parent's keys and its prefix has to stay.

    Args:
        mounts (MountView | None): the boundary facts.
        directory (str): absolute virtual path being listed.
    """
    if mounts is None:
        return []
    base = directory.rstrip("/")
    return [
        root
        for root in mounts.visible_descendants(directory)
        if posixpath.dirname(root) == (base or "/")
    ]


@dataclass(slots=True)
class _TreeNode:
    """One drawn entry: its row, what it counts as, and below it, for a
    directory the walk opened, the entries drawn under it."""

    spec: PathSpec
    stat: FileStat
    is_dir: bool
    leads: FileStat | None = None
    children: list["_TreeNode"] | None = None
    note: str = ""
    unopened: int = 0
    du: int = 0
    missing: bool = False


@dataclass(frozen=True, slots=True)
class _TreeOpts:
    """What one operand's walk reads through and how far it may go.

    Unlike find and du, tree's output is a single document (one root
    line, one drawing, one count), so a per-mount run cannot be
    concatenated: it would print two of each. ``mounts`` says where the
    boundaries are and the ``cross_`` pair reads past one, the way real
    tree crosses one.
    """

    flags: TreeFlags
    read: ReadStreamFn | None
    mounts: MountView | None
    cross_readdir: ReaddirFn | None
    cross_stat: StatFn | None
    target_stat: LinkTargetStat | None
    budget: WalkBudget


@dataclass(slots=True)
class _Drawing:
    """One operand's drawing in progress: lines not yet written and what
    has been counted so far."""

    lines: list[str] = field(default_factory=list)
    dirs: int = 0
    files: int = 0
    unopened: int = 0


@dataclass(frozen=True, slots=True)
class _Ignore:
    """One .gitignore line: the pattern, where it was read, and whether it
    re-includes, names only directories, or is anchored to its file's
    directory."""

    pattern: str
    base: str
    negated: bool
    directory: bool
    anchored: bool


def _gitignore_lines(text: str, base: str) -> list[_Ignore]:
    """A .gitignore's patterns, in order: blank lines and ``#`` comments
    are skipped, trailing blanks dropped, ``!`` re-includes, a trailing
    ``/`` names only a directory, and any other ``/`` anchors the pattern
    to ``base``.

    Args:
        text (str): the file.
        base (str): the virtual directory it was read in.
    """
    rules: list[_Ignore] = []
    for raw in text.splitlines():
        line = raw.rstrip(" ")
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        if negated:
            line = line[1:]
        if line.startswith("\\"):
            line = line[1:]
        directory = line.endswith("/")
        line = line.rstrip("/")
        if not line:
            continue
        anchored = "/" in line
        rules.append(
            _Ignore(line.lstrip("/"), base, negated, directory, anchored)
        )
    return rules


@dataclass(slots=True)
class _Listing:
    """One opened directory: its entries in drawing order (None when it
    has none to draw, ``note`` then saying why), which of them are mounts
    it crosses into, and the ignore rules its subtree inherits."""

    nodes: list[_TreeNode] | None
    note: str = ""
    unopened: int = 0
    crossed: set[int] = field(default_factory=set)
    rules: Sequence[_Ignore] = ()


def _segments_match(parts: list[str], pattern: list[str]) -> bool:
    """Whether a path fits a pattern, a ``**`` for any run of segments
    and, last in the pattern, at least one.

    Only the latest ``**`` is ever retried, since it can take whatever
    an earlier one would have, so the work stays the path's length times
    the pattern's, however many ``**`` a ``.gitignore`` writes.

    Args:
        parts (list[str]): the path's segments.
        pattern (list[str]): the pattern's segments.
    """
    at = want = resume = 0
    star = -1
    while at < len(parts):
        if want < len(pattern) and pattern[want] == "**":
            star, resume = want, at
            want += 1
        elif want < len(pattern) and fnmatch(parts[at], pattern[want]):
            at += 1
            want += 1
        elif star >= 0:
            resume += 1
            at, want = resume, star + 1
        else:
            return False
    return want == len(pattern)


def _name_matcher(rules: Sequence[_Ignore]) -> AnyTailMatcher | None:
    """One matcher over the patterns a name alone decides, so an entry
    none of them matches costs one call however many there are.

    Args:
        rules (Sequence[_Ignore]): the patterns in force.
    """
    patterns = tuple(rule.pattern for rule in rules if not rule.anchored)
    return any_tail_matcher(patterns) if patterns else None


def _ignored(
    rules: Sequence[_Ignore],
    names: AnyTailMatcher | None,
    virtual: str,
    is_dir: bool,
) -> bool:
    """Whether the last .gitignore pattern that matches an entry leaves it
    out.

    Args:
        rules (Sequence[_Ignore]): the patterns in force, outermost first.
        names (AnyTailMatcher | None): ``_name_matcher`` of ``rules``.
        virtual (str): the entry's virtual path.
        is_dir (bool): whether it is a directory.
    """
    out = False
    name = posixpath.basename(virtual)
    named = names is not None and names.matches(name)
    base = None
    parts: list[str] = []
    for rule in rules:
        if rule.directory and not is_dir:
            continue
        if not rule.anchored:
            hit = named and fnmatch(name, rule.pattern)
        else:
            if rule.base != base:
                base = rule.base
                parts = posixpath.relpath(virtual, base).split("/")
            hit = _segments_match(parts, rule.pattern.split("/"))
        if hit:
            out = not rule.negated
    return out


def _sorted(flags: TreeFlags, nodes: list[_TreeNode]) -> list[_TreeNode]:
    """A directory's entries in the order ``--sort`` (``-t``, ``-v``,
    ``-U``) asks for, reversed under ``-r``, directories first under
    ``--dirsfirst``.

    Args:
        flags (TreeFlags): the options.
        nodes (list[_TreeNode]): the entries, in listing order.
    """

    def key(node: _TreeNode) -> tuple[float | str, ...]:
        name = node.stat.name
        if flags.sort == "size":
            return (-content_size(node.stat), name)
        if flags.sort in ("mtime", "ctime"):
            changed = node.stat.ctime if flags.sort == "ctime" else None
            return (iso_timestamp(changed or node.stat.modified) or 0, name)
        return (name,)

    if flags.sort == "version":
        order = [
            nodes[i] for i in sort_by_version([n.stat.name for n in nodes])
        ]
    elif flags.sort == "none":
        order = list(nodes)
    else:
        order = sorted(nodes, key=key)
    if flags.reverse and flags.sort != "none":
        order.reverse()
    if flags.dirs_first:
        order = [n for n in order if n.is_dir] + [
            n for n in order if not n.is_dir
        ]
    return order


async def _gitignore(
    read: ReadStreamFn | None, directory: PathSpec, names: Sequence[str]
) -> list[_Ignore]:
    """The patterns a directory's own .gitignore adds, none when it has
    none or it cannot be read.

    Args:
        read (ReadStreamFn | None): the mount's reader.
        directory (PathSpec): the directory.
        names (Sequence[str]): its listing.
    """
    if read is None or not any(
        posixpath.basename(name) == ".gitignore" for name in names
    ):
        return []
    virtual = f"{directory.virtual.rstrip('/')}/.gitignore"
    path = PathSpec(
        virtual=virtual,
        directory=virtual,
        resolved=False,
        vfs_path=virtual.strip("/"),
    )
    try:
        text = (await materialize(read(path))).decode(errors="replace")
    except WALK_ERRORS as exc:
        logger.debug("tree: cannot read %s: %s", path.virtual, exc)
        return []
    return _gitignore_lines(text, directory.virtual)


async def _open_dir(
    path: PathSpec,
    readdir: ReaddirFn,
    stat: StatFn,
    opts: _TreeOpts,
    rules: Sequence[_Ignore],
) -> _Listing:
    """One directory's own entries, in the order they are drawn.

    A link is drawn as ``name -> target`` and never walked; one leading
    to a directory counts, and filters, as a directory, and one whose
    target cannot be statted as a file, as a dangling one does (tree
    2.2.1).

    A directory the walk could not open (a rule refused it below the
    operand) has no entries and counts itself, so the caller marks its
    own line the way tree does and the run exits 2. One holding more
    entries than ``--filelimit`` is drawn with a note instead.

    Args:
        path (PathSpec): the directory.
        readdir (ReaddirFn): the listing this subtree is read through.
        stat (StatFn): the stat this subtree is read through.
        opts (_TreeOpts): the operand's walk.
        rules (Sequence[_Ignore]): the ignore rules read above it.
    """
    # The mount table is read before the backend, not merged after it. A
    # directory that exists only because mounts sit under it (`/repos`
    # when `/repos/alpha` is mounted) has no backend to list it, so the
    # readdir raises and a merge below it never runs: `tree` reported the
    # one path whose children it could name for certain as unopenable.
    flags = opts.flags
    child_mounts = _child_mounts(opts.mounts, path.virtual)
    limit = opts.budget.listing_limit(path.virtual)
    try:
        entries = await (
            readdir(path) if limit is None else readdir(path, limit=limit)
        )
    except WALK_ERRORS as exc:
        # An absence only. A directory the backend refused (EACCES,
        # ENOTSUP) is there and holds data, so it stays a warning and an
        # unopened row even when mounts sit under it; swallowing that to
        # draw the children would report a readable tree that is not.
        if not (child_mounts and isinstance(exc, MISS_ERRORS)):
            logger.debug("tree: cannot open %s: %s", path.raw_path, exc)
            return _Listing(None, UNOPENABLE_MARK, 1)
        entries = []
    if child_mounts:
        entries = [*entries, *(m for m in child_mounts if m not in entries)]
    if flags.sort != "none":
        entries = sorted(entries)
    entries = [e for e in entries if opts.budget.spend(path.virtual)]
    if flags.gitignore:
        rules = [*rules, *await _gitignore(opts.read, path, entries)]
    names = _name_matcher(rules)

    kept: list[tuple[_TreeNode, bool]] = []
    for entry in entries:
        entry_spec = PathSpec(
            virtual=entry,
            directory=entry,
            resolved=False,
            vfs_path=entry.strip("/"),
            raw_path=f"{path.raw_path.rstrip('/')}/{posixpath.basename(entry)}",
        )
        crossing = entry in child_mounts and opts.cross_readdir is not None
        if crossing:
            s = await _mount_row(flags, opts.cross_stat, entry_spec)
        else:
            try:
                s = await stat(entry_spec)
            except WALK_ERRORS as exc:
                logger.debug("tree: cannot stat %s: %s", entry, exc)
                continue
        if not flags.show_hidden and s.name.startswith("."):
            continue
        if flags.ignore_pattern and fnmatch(s.name, flags.ignore_pattern):
            continue
        is_dir = s.type == FileType.DIRECTORY
        leads: FileStat | None = None
        if s.type == FileType.SYMLINK and opts.target_stat is not None:
            try:
                leads = await opts.target_stat(entry)
            except WALK_ERRORS as exc:
                logger.debug("tree: cannot stat through %s: %s", entry, exc)
            is_dir = leads is not None and leads.type == FileType.DIRECTORY
        if flags.dirs_only and not is_dir:
            continue
        # -P spares only a real directory, a link to one included in its
        # test (tree 2.2.1).
        if (
            flags.match_pattern
            and s.type != FileType.DIRECTORY
            and not fnmatch(s.name, flags.match_pattern)
        ):
            continue
        if rules and _ignored(rules, names, entry, is_dir):
            continue
        kept.append(
            (
                _TreeNode(entry_spec, s, is_dir, leads, du=content_size(s)),
                crossing,
            )
        )
    if flags.file_limit is not None and len(kept) > flags.file_limit:
        return _Listing(
            None, f"  [{len(kept)} entries exceeds filelimit, not opening dir]"
        )
    crossed = {id(node) for node, crossing in kept if crossing}
    return _Listing(
        _sorted(flags, [node for node, _ in kept]),
        crossed=crossed,
        rules=rules,
    )


def _opens(opts: _TreeOpts, node: _TreeNode, depth: int) -> bool:
    """Whether the walk goes into a drawn entry: a real directory, above
    ``-L``, and inside the budget. A directory past the budget is drawn
    but not opened.

    Args:
        opts (_TreeOpts): the operand's walk.
        node (_TreeNode): the entry.
        depth (int): how far down the directory holding it is.
    """
    if node.stat.type != FileType.DIRECTORY:
        return False
    if opts.flags.max_depth is not None and depth + 1 >= opts.flags.max_depth:
        return False
    return opts.budget.opens(node.spec.virtual)


def _read_below(
    opts: _TreeOpts,
    listing: _Listing,
    node: _TreeNode,
    readdir: ReaddirFn,
    stat: StatFn,
) -> tuple[ReaddirFn, StatFn]:
    """The pair a directory's subtree is read through.

    Past a mount root the subtree belongs to another VFS, so the rest of
    this branch reads through the dispatcher. Deeper mounts under it need
    no second switch: the dispatcher already routes every path to its
    owner.

    Args:
        opts (_TreeOpts): the operand's walk.
        listing (_Listing): the directory holding it.
        node (_TreeNode): the directory.
        readdir (ReaddirFn): the listing its parent is read through.
        stat (StatFn): the stat its parent is read through.
    """
    if id(node) not in listing.crossed:
        return readdir, stat
    return opts.cross_readdir or readdir, opts.cross_stat or stat


async def _walk_tree(
    path: PathSpec,
    readdir: ReaddirFn,
    stat: StatFn,
    opts: _TreeOpts,
    depth: int,
    rules: Sequence[_Ignore] = (),
) -> tuple[list[_TreeNode] | None, str, int]:
    """One directory's whole subtree: its drawn entries, the note its own
    line carries, and how many directories below it (itself included)
    could not be opened.

    Args:
        path (PathSpec): the directory.
        readdir (ReaddirFn): the listing this subtree is read through.
        stat (StatFn): the stat this subtree is read through.
        opts (_TreeOpts): the operand's walk.
        depth (int): how far down it is.
        rules (Sequence[_Ignore]): the ignore rules read above it.
    """
    listing = await _open_dir(path, readdir, stat, opts, rules)
    if listing.nodes is None:
        return None, listing.note, listing.unopened
    nodes = listing.nodes
    unopened = 0
    for node in nodes:
        if not _opens(opts, node, depth):
            continue
        sub_readdir, sub_stat = _read_below(opts, listing, node, readdir, stat)
        node.children, node.note, node.unopened = await _walk_tree(
            node.spec, sub_readdir, sub_stat, opts, depth + 1, listing.rules
        )
        if node.children is not None:
            node.du += sum(child.du for child in node.children)
        unopened += node.unopened
    if opts.flags.prune and not opts.flags.dirs_only:
        nodes = [
            n
            for n in nodes
            if n.stat.type != FileType.DIRECTORY or n.children or n.note
        ]
    return nodes, "", unopened


def _counts(nodes: Sequence[_TreeNode]) -> tuple[int, int]:
    dirs = files = 0
    for node in nodes:
        if not node.is_dir:
            files += 1
            continue
        dirs += 1
        sub_dirs, sub_files = _counts(node.children or ())
        dirs += sub_dirs
        files += sub_files
    return dirs, files


def _classify(s: FileStat | None) -> str:
    """The mark ``-F`` puts after a name: ``/`` a directory, ``*`` an
    executable, ``|`` a FIFO, none for anything else or nothing at all.

    Args:
        s (FileStat | None): what the name is, or leads to.
    """
    if s is None:
        return ""
    if s.type == FileType.DIRECTORY:
        return "/"
    if s.type == FileType.FIFO:
        return "|"
    if s.type == FileType.FILE and posix_mode(s) & 0o111:
        return "*"
    return ""


def _size(flags: TreeFlags, node: _TreeNode) -> int:
    return node.du if flags.du else content_size(node.stat)


def _meta(flags: TreeFlags, node: _TreeNode) -> str:
    """The bracket ``-p``, ``-s`` (or ``--du``) and ``-D`` open a line with,
    empty without them.

    Args:
        flags (TreeFlags): the options.
        node (_TreeNode): the entry.
    """
    fields = []
    if flags.perms:
        fields.append(ls_mode_string(node.stat))
    if flags.sizes or flags.du:
        fields.append(f"{_size(flags, node):>11}")
    if flags.dates:
        fields.append(styled_time(node.stat.modified, "locale"))
    return f"[{' '.join(fields)}]  " if fields else ""


def _shown(flags: TreeFlags, node: _TreeNode, root: bool = False) -> str:
    shown = node.spec.raw_path if flags.full_path or root else node.stat.name
    if node.stat.type == FileType.SYMLINK:
        target = node.stat.extra.get(LINK_TARGET_KEY, "")
        tail = _classify(node.leads) if flags.classify else ""
        return f"{shown} -> {target}{tail}"
    return shown + (_classify(node.stat) if flags.classify else "")


def _text_line(
    flags: TreeFlags, node: _TreeNode, prefix: str, last: bool
) -> str:
    lead = "" if flags.no_indent else prefix + (_LAST if last else _BRANCH)
    return lead + _meta(flags, node) + _shown(flags, node) + node.note


def _root_line(flags: TreeFlags, root: _TreeNode) -> str:
    shown = (
        root.spec.raw_path
        if root.missing
        else _meta(flags, root) + _shown(flags, root, True)
    )
    return shown + root.note


def _text_lines(
    flags: TreeFlags, nodes: Sequence[_TreeNode], prefix: str
) -> list[str]:
    lines: list[str] = []
    for i, node in enumerate(nodes):
        last = i == len(nodes) - 1
        lines.append(_text_line(flags, node, prefix, last))
        if node.children:
            extension = _INDENT if last else _VERTICAL
            lines.extend(_text_lines(flags, node.children, prefix + extension))
    return lines


def _flushed(drawing: _Drawing) -> bytes:
    out = format_records(drawing.lines)
    drawing.lines.clear()
    return out


async def _draw(
    listing: _Listing,
    readdir: ReaddirFn,
    stat: StatFn,
    opts: _TreeOpts,
    depth: int,
    prefix: str,
    drawing: _Drawing,
) -> AsyncIterator[bytes]:
    """A listed directory's lines, each written once its own listing is
    read. What is drawn so far goes out before the next directory is
    opened, so a reader that stops early stops the walk.

    Args:
        listing (_Listing): the directory, already opened.
        readdir (ReaddirFn): the listing it was read through.
        stat (StatFn): the stat it was read through.
        opts (_TreeOpts): the operand's walk.
        depth (int): how far down it is.
        prefix (str): the drawing to the left of its entries.
        drawing (_Drawing): the lines and counts so far.
    """
    nodes = listing.nodes or ()
    for i, node in enumerate(nodes):
        last = i == len(nodes) - 1
        below: _Listing | None = None
        sub_readdir, sub_stat = readdir, stat
        if _opens(opts, node, depth):
            if drawing.lines:
                yield _flushed(drawing)
            sub_readdir, sub_stat = _read_below(
                opts, listing, node, readdir, stat
            )
            below = await _open_dir(
                node.spec, sub_readdir, sub_stat, opts, listing.rules
            )
            node.note = below.note
            drawing.unopened += below.unopened
        drawing.lines.append(_text_line(opts.flags, node, prefix, last))
        if node.is_dir:
            drawing.dirs += 1
        else:
            drawing.files += 1
        if below is None:
            continue
        async for piece in _draw(
            below,
            sub_readdir,
            sub_stat,
            opts,
            depth + 1,
            prefix + (_INDENT if last else _VERTICAL),
            drawing,
        ):
            yield piece


_JSON_TYPES = {
    FileType.DIRECTORY: "directory",
    FileType.SYMLINK: "link",
    FileType.FIFO: "fifo",
}


def _json_entry(
    flags: TreeFlags, node: _TreeNode, level: int, root: bool = False
) -> str:
    """One entry as ``-J`` writes it: its fields on one line, a directory's
    contents below it one level in, all on one line under ``-i``.

    Args:
        flags (TreeFlags): the options.
        node (_TreeNode): the entry.
        level (int): how deep it is, the operand at 1.
    """
    name = node.spec.raw_path if flags.full_path or root else node.stat.name
    kind = _JSON_TYPES.get(node.stat.type, "file")
    text = f'{{"type":"{kind}","name":{json.dumps(name, ensure_ascii=False)}'
    if node.stat.type == FileType.SYMLINK:
        target = node.stat.extra.get(LINK_TARGET_KEY, "")
        text += f',"target":{json.dumps(target, ensure_ascii=False)}'
    if flags.perms:
        mode = posix_mode(node.stat) & 0o7777
        text += f',"mode":"{mode:04o}","prot":"{ls_mode_string(node.stat)}"'
    if flags.sizes or flags.du:
        text += f',"size":{_size(flags, node)}'
    if flags.dates:
        text += f',"time":"{styled_time(node.stat.modified, "locale")}"'
    if node.note:
        error = node.note.strip().removeprefix("[").removesuffix("]")
        newline, indent = ("", "") if flags.no_indent else ("\n", "  " * level)
        return f'{text},"contents":[{{"error": "{error}"}}{newline}{indent}]}}'
    if not node.children:
        return text + "}"
    if flags.no_indent:
        inner = ",".join(
            _json_entry(flags, child, level + 1) for child in node.children
        )
        return f'{text},"contents":[{inner}]}}'
    pad = "  " * (level + 1)
    inner = ",\n".join(
        pad + _json_entry(flags, child, level + 1) for child in node.children
    )
    return f'{text},"contents":[\n{inner}\n{"  " * level}]}}'


def _summary(dirs: int, files: int, dirs_only: bool) -> str:
    dir_word = "directory" if dirs == 1 else "directories"
    if dirs_only:
        return f"{dirs} {dir_word}"
    file_word = "file" if files == 1 else "files"
    return f"{dirs} {dir_word}, {files} {file_word}"


def _json_report(flags: TreeFlags, dirs: int, files: int, du: int) -> str:
    text = '{"type":"report"'
    if flags.du:
        text += f',"size":{du}'
    text += f',"directories":{dirs}'
    if not flags.dirs_only:
        text += f',"files":{files}'
    return text + "}"


async def _rendered(
    paths: list[PathSpec],
    readdir: ReaddirFn,
    stat: StatFn,
    flags: TreeFlags,
    read: ReadStreamFn | None,
    stat_path: StatPath | None,
    readdir_path: ReaddirPath | None,
    mounts: MountView | None,
    links: LinkView | None,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """The operands' drawing, under one summary; see ``tree``.

    Args:
        paths (list[PathSpec]): the operands to draw, in order.
        readdir (ReaddirFn): this mount's directory listing.
        stat (StatFn): this mount's stat.
        flags (TreeFlags): the options.
        read (ReadStreamFn | None): this mount's reader.
        stat_path (StatPath | None): dispatcher-backed stat.
        readdir_path (ReaddirPath | None): dispatcher-backed readdir.
        mounts (MountView | None): where the mount boundaries are.
        links (LinkView | None): the namespace's symlink facts.
        io (IOResult): the result the status and stderr settle into.
    """
    cross_readdir: ReaddirFn | None = (
        partial(_cross_readdir, readdir_path)
        if readdir_path is not None
        else None
    )
    if cross_readdir is not None and flags.one_file_system:
        cross_readdir = _not_crossed
    cross_stat = (
        partial(_cross_stat, stat_path) if stat_path is not None else None
    )
    live = not (flags.json or flags.prune or flags.du)
    roots: list[_TreeNode] = []
    stopped: list[str] = []
    total_dirs = 0
    total_files = 0
    failed = False
    for path in paths:
        root_label = path.raw_path or path.virtual
        # -f names every entry from the operand, which drops the operand's
        # trailing slashes first (tree 2.2.1).
        if flags.full_path:
            root_label = root_label.rstrip("/") or "/"
        spec = PathSpec(
            virtual=path.virtual,
            directory=path.directory,
            resolved=path.resolved,
            vfs_path=path.vfs_path,
            raw_path=root_label,
        )
        # What the operand is decides its result, so it is resolved before
        # the walk rather than inferred from how a backend answered readdir
        # on it: an object store lists a file key as an empty prefix, lists
        # a missing path as one too, and Graph 404s, which read as three
        # different trees. The probe asks both channels a backend can
        # answer on, so a directory that exists only as its children still
        # reports as one and None means nothing is there.
        #
        # tree prints the same inline marker either way and nothing on
        # stderr; what differs is the count and the status. A
        # non-directory exists, so it is counted and the exit stays 0; a
        # path that is not there is not counted and exits 2.
        start = await stat_path(path) if stat_path is not None else None
        row = start or FileStat(
            name=posixpath.basename(root_label), type=FileType.DIRECTORY
        )
        root = _TreeNode(spec, row, True, du=content_size(row))
        roots.append(root)
        if stat_path is not None and start is None:
            root.note = UNOPENABLE_MARK
            root.missing = True
            root.du = 0
            failed = True
            if live:
                yield format_records([_root_line(flags, root)])
            continue
        if start is not None and start.type != FileType.DIRECTORY:
            root.is_dir = False
            root.note = UNOPENABLE_MARK
            total_files += 1
            if live:
                yield format_records([_root_line(flags, root)])
            continue
        budget = WalkBudget(path, mounts)
        opts = _TreeOpts(
            flags,
            read,
            mounts,
            cross_readdir,
            cross_stat,
            links.target_stat if links is not None else None,
            budget,
        )
        if live:
            listing = await _open_dir(spec, readdir, stat, opts, ())
            root.children, root.note = listing.nodes, listing.note
            drawing = _Drawing(
                [_root_line(flags, root)], unopened=listing.unopened
            )
            async for piece in _draw(
                listing, readdir, stat, opts, 0, "", drawing
            ):
                yield piece
            if drawing.lines:
                yield _flushed(drawing)
            root.unopened = drawing.unopened
            counted = (drawing.dirs, drawing.files)
        else:
            root.children, root.note, root.unopened = await _walk_tree(
                spec, readdir, stat, opts, 0
            )
            counted = _counts(root.children or ())
        stopped.extend(f"tree: {line}" for line in budget.stopped)
        if root.children is not None:
            root.du += sum(child.du for child in root.children)
        # With stat_path wired the two clear cases are already answered
        # above, so this covers a directory that exists but could not be
        # read (a permission error). A root that lists entries none of
        # which stat draws plainly and exits 0, as tree 2.2.1 does.
        if root.unopened and root.children is None:
            failed = True
            continue
        # tree counts the root as a directory once it has any listed
        # entry (an empty root reports 0), or a note in place of them.
        if root.children or root.note:
            total_dirs += counted[0] + 1
            total_files += counted[1]
        # A directory below the root it could not open is marked inline
        # and makes the run exit 2, as tree does, with nothing on stderr.
        failed = failed or root.unopened > 0
    # A walk past walk_limit draws what it listed and says where it
    # stopped, exiting 2 as for a directory it could not open.
    io.exit_code = 2 if failed or stopped else 0
    if stopped:
        io.stderr = format_records(stopped)
    du = sum(root.du for root in roots)
    if live:
        if not flags.no_report:
            yield format_records(
                ["", _summary(total_dirs, total_files, flags.dirs_only)]
            )
    elif flags.json:
        report = _json_report(flags, total_dirs, total_files, du)
        if flags.no_indent:
            entries = [_json_entry(flags, root, 1, True) for root in roots]
            if not flags.no_report:
                entries.append(report)
            yield encode_text(f"[{','.join(entries)}]\n")
        else:
            yield encode_text(
                "[\n"
                + ",\n".join(
                    "  " + _json_entry(flags, root, 1, True) for root in roots
                )
                + ("\n,\n  " + report if not flags.no_report else "\n")
                + "\n]\n"
            )
    else:
        lines: list[str] = []
        for root in roots:
            lines.append(_root_line(flags, root))
            lines.extend(_text_lines(flags, root.children or (), ""))
        if not flags.no_report:
            summary = _summary(total_dirs, total_files, flags.dirs_only)
            if flags.du:
                summary = f" {du:>11} bytes used in {summary}"
            lines += ["", summary]
        yield format_records(lines)


async def tree(
    paths: list[PathSpec],
    *,
    readdir: ReaddirFn,
    stat: StatFn,
    flags: TreeFlags = TreeFlags(),
    read: ReadStreamFn | None = None,
    stat_path: StatPath | None = None,
    readdir_path: ReaddirPath | None = None,
    mounts: MountView | None = None,
    links: LinkView | None = None,
) -> tuple[ByteSource, IOResult]:
    """Render each operand's tree, tree's drawing or its ``-J`` JSON, under
    one summary.

    Unlike find and du, tree's output is a single document: each root
    line and its drawing in operand order, then one count. Concatenating
    a per-mount run would print two counts, so a nested mount is crossed
    here instead, the way real ``tree`` crosses one (pinned on tree
    2.2.1: the mounted filesystem's entries are drawn under the mount
    point, the covered ones are not drawn at all, and the summary counts
    the whole thing).

    The drawing is written as the walk goes, unless an option needs a
    directory's whole subtree before its first line: ``-J``, ``--prune``
    and ``--du``. The exit status and any stderr settle into the returned
    ``IOResult`` when the output has been read.

    Args:
        paths (list[PathSpec]): the operands to draw, in order.
        readdir (ReaddirFn): this mount's directory listing.
        stat (StatFn): this mount's stat.
        flags (TreeFlags): the options.
        read (ReadStreamFn | None): this mount's reader, for the
            .gitignore files ``--gitignore`` reads.
        stat_path (StatPath | None): dispatcher-backed stat, used for the
            operand itself and for entries past a mount boundary.
        readdir_path (ReaddirPath | None): dispatcher-backed readdir,
            which is how a subtree on another mount is read at all.
        mounts (MountView | None): where the mount boundaries are.
        links (LinkView | None): the namespace's symlink facts, which say
            what a drawn link leads to.
    """
    io = IOResult()
    pieces = _rendered(
        paths,
        readdir,
        stat,
        flags,
        read,
        stat_path,
        readdir_path,
        mounts,
        links,
        io,
    )
    # The first piece is drawn here, so what refuses the walk outright
    # still raises before there is any output.
    first = await anext(pieces, b"")
    return async_chain([first, pieces]), io


def facts(fl: FlagView, operands: Sequence[str | PathSpec]) -> LineFacts:
    """A tree line reads below every path it names and walks into the
    mounts below unless ``-x``.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        operands (Sequence[str | PathSpec]): the line's operands.
    """
    return LineFacts(walks=not fl.as_bool("x"), reads_subtree=True)


__all__ = ["facts", "tree"]


def parse_flags(flags: Mapping[str, FlagValue]) -> TreeFlags | IOResult:
    """tree's options, ``-L`` and ``--filelimit`` read by mirage-rs before
    any operand is resolved; ``-t``, ``-v``, ``-U`` and ``--sort`` each set
    the order, the last one typed winning.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.

    Returns:
        TreeFlags | IOResult: the flags, or tree's refusal of a level or
        an order.
    """
    fl = FlagView(flags, spec=SPECS["tree"])
    try:
        values = scan("tree", [*fl.texts("L"), *fl.texts("filelimit")])
    except StreamRefusal as refusal:
        return refused(refusal)
    level = values["L"]
    limit = values["filelimit"]
    assert level is None or isinstance(level, int)
    assert limit is None or isinstance(limit, int)
    sort: TreeSort = "name"
    for name, value in fl.occurrences("t", "v", "U", "sort"):
        if name in _SHORTHANDS:
            if value is True:
                sort = _SHORTHANDS[name]
            continue
        typed = str(value)
        if typed not in _SORTS:
            return IOResult(
                exit_code=1,
                stdout=(",".join(_SORTS) + "\n").encode(),
                stderr=(
                    f"tree: Sort type '{typed}' not valid, should be one of: "
                ).encode(),
            )
        sort = typed
    return TreeFlags(
        max_depth=level,
        show_hidden=fl.as_bool("a"),
        ignore_pattern=fl.as_str("args_I"),
        dirs_only=fl.as_bool("d"),
        match_pattern=fl.as_str("P"),
        one_file_system=fl.as_bool("x"),
        full_path=fl.as_bool("f"),
        no_indent=fl.as_bool("i"),
        sizes=fl.as_bool("s"),
        dates=fl.as_bool("D"),
        perms=fl.as_bool("p"),
        classify=fl.as_bool("F"),
        sort=sort,
        reverse=fl.as_bool("r"),
        dirs_first=fl.as_bool("dirsfirst"),
        no_report=fl.as_bool("noreport"),
        du=fl.as_bool("du"),
        prune=fl.as_bool("prune"),
        gitignore=fl.as_bool("gitignore"),
        file_limit=limit,
        json=fl.as_bool("J"),
    )


async def tree_generic(
    parsed: TreeFlags,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    readdir: ReaddirFn,
    stat: StatFn,
    unbounded: tuple[ReaddirFn, StatFn] | None = None,
    read: ReadStreamFn | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run tree over resolved operands.

    Args:
        parsed (TreeFlags): the options, read before the operands were.
        paths (list[PathSpec]): the operands.
        texts (list[str]): the raw words.
        ctx (Context): the dispatcher context.
        readdir (ReaddirFn): the walk's readdir.
        stat (StatFn): the walk's stat.
        unbounded (tuple[ReaddirFn, StatFn] | None): the walk to take when
            no ``-L`` bounds it (one the mount answers whole), else
            ``readdir`` and ``stat``.
        read (ReadStreamFn | None): the mount's reader, for
            ``--gitignore``.
    """
    if unbounded is not None and parsed.max_depth is None:
        readdir, stat = unbounded
    return await tree(
        paths,
        readdir=readdir,
        stat=stat,
        flags=parsed,
        read=read,
        stat_path=vfs_stat_path(ctx.vfs),
        readdir_path=vfs_readdir_path(ctx.vfs),
        mounts=mounts_of(ctx),
        links=links_of(ctx),
    )

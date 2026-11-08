import json
import logging
import posixpath
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
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
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused, scan
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
from mirage.utils.fnmatch import fnmatch
from mirage.utils.stat_view import content_size, mtime_ns, posix_mode
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


def _segments_match(parts: list[str], pattern: list[str]) -> bool:
    if not pattern:
        return not parts
    if pattern[0] == "**":
        return any(
            _segments_match(parts[at:], pattern[1:])
            for at in range(len(parts) + 1)
        )
    return (
        bool(parts)
        and fnmatch(parts[0], pattern[0])
        and _segments_match(parts[1:], pattern[1:])
    )


def _ignored(rules: Sequence[_Ignore], virtual: str, is_dir: bool) -> bool:
    """Whether the last .gitignore pattern that matches an entry leaves it
    out.

    Args:
        rules (Sequence[_Ignore]): the patterns in force, outermost first.
        virtual (str): the entry's virtual path.
        is_dir (bool): whether it is a directory.
    """
    out = False
    for rule in rules:
        if rule.directory and not is_dir:
            continue
        relative = posixpath.relpath(virtual, rule.base)
        if rule.anchored:
            hit = _segments_match(relative.split("/"), rule.pattern.split("/"))
        else:
            hit = fnmatch(posixpath.basename(virtual), rule.pattern)
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

    def key(node: _TreeNode) -> tuple[int | str, ...]:
        name = node.stat.name
        if flags.sort == "size":
            return (-content_size(node.stat), name)
        if flags.sort in ("mtime", "ctime"):
            return (mtime_ns(node.stat) or 0, name)
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


async def _walk_tree(
    path: PathSpec,
    readdir: ReaddirFn,
    stat: StatFn,
    flags: TreeFlags,
    *,
    depth: int,
    rules: Sequence[_Ignore] = (),
    read: ReadStreamFn | None = None,
    mounts: MountView | None = None,
    cross_readdir: ReaddirFn | None = None,
    cross_stat: StatFn | None = None,
    target_stat: LinkTargetStat | None = None,
    budget: WalkBudget | None = None,
) -> tuple[list[_TreeNode] | None, str, int]:
    """One directory's drawn entries, the note its own line carries, and
    how many directories in its subtree (itself included) could not be
    opened.

    A link is drawn as ``name -> target`` and never walked; one leading
    to a directory counts, and filters, as a directory, and one whose
    target cannot be statted as a file, as a dangling one does (tree
    2.2.1).

    A directory the walk could not open (a rule refused it below the
    operand) has no entries and counts itself, so the caller marks its
    own line the way tree does and the run exits 2. A directory past
    ``budget`` is drawn but not opened, and one holding more entries than
    ``--filelimit`` is drawn with a note instead.
    """
    # The mount table is read before the backend, not merged after it. A
    # directory that exists only because mounts sit under it (`/repos`
    # when `/repos/alpha` is mounted) has no backend to list it, so the
    # readdir raises and a merge below it never runs: `tree` reported the
    # one path whose children it could name for certain as unopenable.
    child_mounts = _child_mounts(mounts, path.virtual)
    limit = None if budget is None else budget.listing_limit(path.virtual)
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
            return None, UNOPENABLE_MARK, 1
        entries = []
    if child_mounts:
        entries = [*entries, *(m for m in child_mounts if m not in entries)]
    if flags.sort != "none":
        entries = sorted(entries)
    if budget is not None:
        entries = [e for e in entries if budget.spend(path.virtual)]
    if flags.gitignore:
        rules = [*rules, *await _gitignore(read, path, entries)]

    kept: list[tuple[_TreeNode, bool]] = []
    for entry in entries:
        entry_spec = PathSpec(
            virtual=entry,
            directory=entry,
            resolved=False,
            vfs_path=entry.strip("/"),
            raw_path=f"{path.raw_path.rstrip('/')}/{posixpath.basename(entry)}",
        )
        crossing = entry in child_mounts and cross_readdir is not None
        if crossing:
            # The mount table already says this is a directory, and the
            # backend serving it may not stat its own root (an empty
            # mount, or a prefix store with no marker object).
            s = FileStat(
                name=posixpath.basename(entry.rstrip("/")),
                type=FileType.DIRECTORY,
            )
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
        if s.type == FileType.SYMLINK and target_stat is not None:
            try:
                leads = await target_stat(entry)
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
        if rules and _ignored(rules, entry, is_dir):
            continue
        kept.append(
            (
                _TreeNode(entry_spec, s, is_dir, leads, du=content_size(s)),
                crossing,
            )
        )
    if flags.file_limit is not None and len(kept) > flags.file_limit:
        return (
            None,
            f"  [{len(kept)} entries exceeds filelimit, not opening dir]",
            0,
        )
    crossed = {id(node) for node, crossing in kept if crossing}
    nodes: list[_TreeNode] = []
    unopened = 0
    for node in _sorted(flags, [node for node, _ in kept]):
        nodes.append(node)
        if node.stat.type != FileType.DIRECTORY:
            continue
        if flags.max_depth is not None and depth + 1 >= flags.max_depth:
            continue
        if budget is not None and not budget.opens(node.spec.virtual):
            continue
        # Past a mount root the subtree belongs to another VFS, so
        # the rest of this branch reads through the dispatcher. Deeper
        # mounts under it need no second switch: the dispatcher already
        # routes every path to its owner.
        crossing = id(node) in crossed
        sub_readdir = cross_readdir if crossing and cross_readdir else readdir
        sub_stat = cross_stat if crossing and cross_stat else stat
        node.children, node.note, node.unopened = await _walk_tree(
            node.spec,
            sub_readdir,
            sub_stat,
            flags,
            depth=depth + 1,
            rules=rules,
            read=read,
            mounts=mounts,
            cross_readdir=cross_readdir,
            cross_stat=cross_stat,
            target_stat=target_stat,
            budget=budget,
        )
        if node.children is not None:
            node.du += sum(child.du for child in node.children)
        unopened += node.unopened
    if flags.prune and not flags.dirs_only:
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


def _text_lines(
    flags: TreeFlags, nodes: Sequence[_TreeNode], prefix: str
) -> list[str]:
    lines: list[str] = []
    for i, node in enumerate(nodes):
        last = i == len(nodes) - 1
        lead = "" if flags.no_indent else prefix + (_LAST if last else _BRANCH)
        lines.append(
            lead + _meta(flags, node) + _shown(flags, node) + node.note
        )
        if node.children:
            extension = _INDENT if last else _VERTICAL
            lines.extend(_text_lines(flags, node.children, prefix + extension))
    return lines


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
) -> tuple[bytes, IOResult]:
    """Render each operand's tree, tree's drawing or its ``-J`` JSON, under
    one summary.

    Unlike find and du, tree's output is a single document: each root
    line and its drawing in operand order, then one count. Concatenating
    a per-mount run would print two counts, so a nested mount is crossed
    here instead, the way real ``tree`` crosses one (pinned on tree
    2.2.1: the mounted filesystem's entries are drawn under the mount
    point, the covered ones are not drawn at all, and the summary counts
    the whole thing).

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
            failed = True
            continue
        if start is not None and start.type != FileType.DIRECTORY:
            root.is_dir = False
            root.note = UNOPENABLE_MARK
            total_files += 1
            continue
        budget = WalkBudget(path, mounts)
        root.children, root.note, root.unopened = await _walk_tree(
            spec,
            readdir,
            stat,
            flags,
            depth=0,
            read=read,
            mounts=mounts,
            cross_readdir=cross_readdir,
            cross_stat=cross_stat,
            target_stat=links.target_stat if links is not None else None,
            budget=budget,
        )
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
            dirs, files = _counts(root.children or ())
            total_dirs += dirs + 1
            total_files += files
        # A directory below the root it could not open is marked inline
        # and makes the run exit 2, as tree does, with nothing on stderr.
        failed = failed or root.unopened > 0
    du = sum(root.du for root in roots)
    if flags.json:
        report = _json_report(flags, total_dirs, total_files, du)
        if flags.no_indent:
            entries = [_json_entry(flags, root, 1, True) for root in roots]
            if not flags.no_report:
                entries.append(report)
            body = f"[{','.join(entries)}]\n"
        else:
            body = (
                "[\n"
                + ",\n".join(
                    "  " + _json_entry(flags, root, 1, True) for root in roots
                )
                + ("\n,\n  " + report if not flags.no_report else "\n")
                + "\n]\n"
            )
        out = body.encode()
    else:
        lines: list[str] = []
        for root in roots:
            shown = (
                root.spec.raw_path
                if root.missing
                else _meta(flags, root) + _shown(flags, root, True)
            )
            lines.append(shown + root.note)
            lines.extend(_text_lines(flags, root.children or (), ""))
        if not flags.no_report:
            summary = _summary(total_dirs, total_files, flags.dirs_only)
            if flags.du:
                summary = f" {du:>11} bytes used in {summary}"
            lines += ["", summary]
        out = format_records(lines)
    # A walk past walk_limit draws what it listed and says where it
    # stopped, exiting 2 as for a directory it could not open.
    return out, IOResult(
        exit_code=2 if failed or stopped else 0,
        stderr=format_records(stopped) if stopped else None,
    )


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

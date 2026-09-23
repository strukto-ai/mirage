from collections.abc import Awaitable, Callable

from mirage.commands.builtin.generic.archive.types import (Entry, MemberKind,
                                                           Problem, Scan,
                                                           Walked)
from mirage.ops.types import LinkView, MountView
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError

# A mount boundary is a filesystem boundary, so both archivers stop at
# one and say so in GNU tar's --one-file-system wording. Descending would
# archive by accident exactly what the mount-root refusal forbids on
# purpose.
OTHER_FILESYSTEM = "file is on a different filesystem; not dumped"
# Why a path could not be reached, in GNU's strerror wording. Both ride
# on a fatal Problem; tar prints them after "Cannot stat: " and Info-ZIP
# words every unreachable name the same way, so it ignores the reason.
_NO_SUCH = "No such file or directory"
_TOO_MANY_LEVELS = "Too many levels of symbolic links"
# A directory below the operand the walk could not open: a rule refused
# it. Rides on an ``unreadable`` Problem; tar prints it after "Cannot
# open: " and fails the run, Info-ZIP stores the directory and is silent.
_PERMISSION_DENIED = "Permission denied"

StatFn = Callable[[PathSpec], Awaitable[FileStat]]
WalkFn = Callable[[PathSpec, str], Awaitable[Walked]]
DirProbe = Callable[[PathSpec], Awaitable[bool]]


def _link_target(stat: FileStat) -> str:
    target = stat.extra.get(LINK_TARGET_KEY)
    return target if isinstance(target, str) else ""


def _child_spec(virtual: str, root: PathSpec) -> PathSpec:
    """A PathSpec for a walked descendant of one operand.

    The walk reports absolute virtual paths; reading their bytes needs
    the backend key too, which is the virtual path with this mount's
    prefix removed.

    Args:
        virtual (str): the descendant's absolute virtual path.
        root (PathSpec): the operand it was walked from.
    """
    cut = len(root.virtual.rstrip("/")) - len(root.vfs_path.strip("/"))
    prefix = root.virtual[:cut].rstrip("/")
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1] or "/",
                    vfs_path=mount_key(virtual, prefix),
                    raw_path=virtual)


def _same_mount(mounts: MountView | None, one: str, other: str) -> bool:
    """Whether two virtual paths are served by the same mount.

    Args:
        mounts (MountView | None): where the mount boundaries are;
            None (outside a workspace) means there is only one mount.
        one (str): a virtual path.
        other (str): another virtual path.
    """
    if mounts is None:
        return True
    return mounts.root_of(one) == mounts.root_of(other)


async def _subtree(
    root: PathSpec,
    base: str,
    name_base: str,
    walk: WalkFn,
    links: LinkView | None,
    mounts: MountView | None,
) -> tuple[list[Entry], list[str], list[str]]:
    """Every entry under one directory, named under ``name_base``.

    Three sources have to be merged because no single one can see them
    all: the backend walk (files and directories), the namespace (its
    symlinks, which no backend readdir reports), and the mount table (a
    nested mount, whose keys live in another VFS entirely).

    ``base`` and ``name_base`` differ only when a link is being followed:
    the walk runs over the target while the members keep the link's own
    name.

    Args:
        root (PathSpec): the operand, for backend keys.
        base (str): absolute virtual path actually walked.
        name_base (str): absolute virtual path the members are named
            under.
        walk (WalkFn): subtree listing, by find type.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.

    Returns:
        tuple: the entries, the virtual path of each mount root that
        stopped the walk, and the virtual path of each directory the
        walk could not open.
    """
    walked = _child_spec(base, root) if base != root.virtual else root
    found: dict[str, tuple[MemberKind, str]] = {}
    dirs = await walk(walked, "d")
    for virtual in dirs.paths:
        if virtual.rstrip("/") != base:
            found[virtual.rstrip("/")] = ("dir", "")
    files = await walk(walked, "f")
    for virtual in files.paths:
        found[virtual.rstrip("/")] = ("file", "")
    # Named under name_base like the entries, once each (both listings
    # meet the same closed door).
    unreadable = [
        name_base.rstrip("/") + u.rstrip("/")[len(base.rstrip("/")):]
        for u in dict.fromkeys((*dirs.unreadable, *files.unreadable))
    ]
    if links is not None:
        for virtual, stat in links.subtree(base):
            found[virtual.rstrip("/")] = ("link", _link_target(stat))
    # Two lists, because pruning and naming are different questions. A
    # mount the session cannot see still shadows the parent backend's
    # keys, so every descendant prunes; only the ones it may be told
    # about become a member and a "different filesystem" warning, since
    # both hand back the name a hide exists to withhold.
    crossings = mounts.descendants(base) if mounts is not None else []
    visible_crossings = (mounts.visible_descendants(base)
                         if mounts is not None else [])
    for crossing in visible_crossings:
        # The mountpoint itself is still an entry, exactly as GNU's
        # --one-file-system keeps the directory and drops its contents.
        found[crossing.rstrip("/")] = ("dir", "")
    below = [c.rstrip("/") + "/" for c in crossings]
    entries: list[Entry] = []
    for virtual, (kind, target) in found.items():
        if any(virtual.startswith(c) for c in below):
            continue
        named = name_base.rstrip("/") + virtual[len(base.rstrip("/")):]
        entries.append(
            Entry(name_path=named,
                  kind=kind,
                  target=target,
                  read=_child_spec(virtual, root) if kind == "file" else None))
    entries.sort(key=lambda entry: entry.name_path)
    return entries, [c.rstrip("/") for c in visible_crossings], unreadable


async def _follow(
    virtual: str,
    root: PathSpec,
    stat: StatFn,
    walk: WalkFn,
    links: LinkView | None,
    mounts: MountView | None,
    recurse: bool,
) -> tuple[list[Entry], list[str], str, list[str]]:
    """What dereferencing puts in the archive in place of one symlink.

    The member keeps the link's own name and takes the target's content,
    which is what dereferencing means. Two links resolving to the same
    file are not a loop and both are archived; a real loop is whatever
    ``resolve`` refuses to resolve, since the namespace already walks
    the chain under a hop limit and raises ELOOP at the end of it.

    Args:
        virtual (str): the link's absolute virtual path.
        root (PathSpec): the operand, for backend keys.
        stat (StatFn): backend stat.
        walk (WalkFn): subtree listing, by find type.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.
        recurse (bool): whether a target directory contributes its
            contents as well as itself.

    Returns:
        tuple: the entries, why anything was skipped, why the link was
        unreachable at all (empty when it was reached), and the
        directories below the target the walk could not open.
    """
    if links is None:
        return [], [], "", []
    try:
        target = links.resolve(virtual)
    except CycleError:
        return [], [], _TOO_MANY_LEVELS, []
    if not _same_mount(mounts, virtual, target):
        return [], [OTHER_FILESYSTEM], "", []
    spec = _child_spec(target, root)
    try:
        target_stat = await stat(spec)
    except (FileNotFoundError, ValueError):
        return [], [], _NO_SUCH, []
    if target_stat.type != FileType.DIRECTORY:
        return [Entry(name_path=virtual, kind="file", read=spec)], [], "", []
    if not recurse:
        return [Entry(name_path=virtual, kind="dir")], [], "", []
    entries, crossings, unreadable = await _subtree(root, target, virtual,
                                                    walk, links, mounts)
    reasons = [OTHER_FILESYSTEM] * len(crossings)
    return ([Entry(name_path=virtual, kind="dir"),
             *entries], reasons, "", unreadable)


def _unreadable_problems(closed: list[str]) -> list[Problem]:
    """The problems for directories a walk could not open.

    Args:
        closed (list[str]): their absolute virtual paths, walk order.
    """
    return [
        Problem(path=virtual, reason=_PERMISSION_DENIED, unreadable=True)
        for virtual in closed
    ]


async def scan_operand(
    path: PathSpec,
    *,
    stat: StatFn,
    walk: WalkFn,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    dereference: bool = False,
    recurse: bool = True,
) -> Scan:
    """Everything one operand contributes to an archive.

    This is the whole of what tar and zip share: which paths go in, what
    each one is, and which of them could not be reached. The two formats
    disagree about the defaults, not the traversal, so both are
    parameters: tar stores a symlink unless ``-h`` says to follow it and
    always descends, zip follows unless ``-y`` says otherwise and only
    descends under ``-r``.

    Args:
        path (PathSpec): the operand, glob-resolved and already re-based
            by any directory option.
        stat (StatFn): backend stat, raising when nothing is there.
        walk (WalkFn): subtree listing, by find type.
        links (LinkView | None): the namespace's symlink facts.
        mounts (MountView | None): where the mount boundaries are.
        dereference (bool): archive what a symlink points at rather than
            the link.
        recurse (bool): whether a directory contributes its contents as
            well as itself.
    """
    base = path.virtual.rstrip("/") or "/"
    entries: list[Entry] = []
    crossings: list[str] = []
    problems: list[Problem] = []
    link_stat = links.stat_at(path.virtual) if links is not None else None
    if link_stat is not None and not dereference:
        entries.append(
            Entry(name_path=base, kind="link", target=_link_target(link_stat)))
    elif link_stat is not None:
        followed, why, unreachable, closed = await _follow(
            base, path, stat, walk, links, mounts, recurse)
        if unreachable:
            return Scan(problems=(Problem(path=base,
                                          reason=unreachable,
                                          fatal=True), ),
                        missing=True)
        entries.extend(followed)
        problems.extend(Problem(path=base, reason=reason) for reason in why)
        problems.extend(_unreadable_problems(closed))
    else:
        try:
            root_stat = await stat(path)
        except (FileNotFoundError, ValueError):
            return Scan(problems=(Problem(path=base,
                                          reason=_NO_SUCH,
                                          fatal=True), ),
                        missing=True)
        if root_stat.type != FileType.DIRECTORY:
            entries.append(Entry(name_path=base, kind="file", read=path))
        else:
            entries.append(Entry(name_path=base, kind="dir"))
            if recurse:
                below, crossings, closed = await _subtree(
                    path, base, base, walk, links, mounts)
                entries.extend(below)
                problems.extend(_unreadable_problems(closed))
    if dereference and links is not None:
        expanded: list[Entry] = []
        for entry in entries:
            if entry.kind != "link":
                expanded.append(entry)
                continue
            followed, why, unreachable, closed = await _follow(
                entry.name_path, path, stat, walk, links, mounts, recurse)
            if unreachable:
                problems.append(
                    Problem(path=entry.name_path,
                            reason=unreachable,
                            fatal=True))
                continue
            expanded.extend(followed)
            problems.extend(
                Problem(path=entry.name_path, reason=reason) for reason in why)
            problems.extend(_unreadable_problems(closed))
        entries = expanded
    return Scan(entries=tuple(entries),
                crossings=tuple(crossings),
                problems=tuple(problems))

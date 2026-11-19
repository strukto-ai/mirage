# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import logging
import posixpath
from collections.abc import Callable, Mapping
from dataclasses import replace
from functools import partial

from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import dot_walk_error, eexist, eloop, enoent
from mirage.errors.render import operand_spelling
from mirage.errors.types import DotWalkError, DotWalkLoop, FsCondition
from mirage.runtime.types import DispatchFn
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    PathSpec,
    ReaddirFn,
    StatFn,
)
from mirage.utils.path import (
    CycleError,
    dot_lookups,
    dot_prefixes,
    norm,
    parent,
    resolve_path,
)
from mirage.view.types import LinkView, ReaddirPath, StatPath
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)

# What an existence probe reads as nothing there: every miss, and a link
# loop, which the walk reaches nothing through.
_ABSENT: tuple[type[Exception], ...] = (*MISS_ERRORS, DotWalkLoop)


def resolve_target(o: str | PathSpec, cwd: PathSpec | str | None) -> PathSpec:
    """Resolve a file a transfer reads or writes (curl -o, wget -O).

    Args:
        o (str | PathSpec): the file as the line named it.
        cwd (PathSpec | str | None): the session working directory as
            ``Context.cwd`` carries it; None resolves against the
            root.
    """
    return PathSpec.from_str_path(o, cwd=cwd or "/")


def default_paths(
    paths: list[PathSpec], cwd: PathSpec | None
) -> list[PathSpec]:
    """Default a command's path operands the way the shell would.

    Args:
        paths (list[PathSpec]): operands as parsed; returned untouched
            when non-empty.
        cwd (PathSpec | None): the session working directory as
            ``Context.cwd`` carries it.
    """
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [PathSpec(vfs_path="", virtual="/", directory="/")]


async def dispatch_stat(dispatch: DispatchFn, path: PathSpec) -> FileStat:
    """Stat a path via dispatch in the shape the generics' probes take.

    ``dest_kind`` and its kin are written against a backend ``stat`` that
    raises on a miss, so a dispatcher answer of nothing becomes ENOENT.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to stat.
    """
    stat: FileStat | None
    stat, _ = await dispatch("stat", path)
    if stat is None:
        raise enoent(path)
    return stat


async def resolve_path_stat(
    dispatch: DispatchFn, path: PathSpec
) -> FileStat | None:
    """What a path is, asked on both channels a backend can answer on.

    A point lookup alone cannot decide. On a prefix store a directory is
    not an object, it is the set of keys under it, so ``stat`` misses
    what ``readdir`` would list. Absence therefore takes *both* channels
    coming back empty, which is the only evidence that nothing is there.

    The listing has to be non-empty to count: those stores answer a
    missing path with ``[]`` rather than raising, and cannot hold an
    empty directory anyway (one with no keys under it does not exist).
    Measured across every integ target: an implicit directory answers
    here, a missing path does not. That holds only while a backend's
    readdir refuses a path it cannot prove: postgres answered
    ``tables``/``views`` under any first segment, and every absent
    schema read as a directory here.

    A link loop in the path is absence too: the walk reaches nothing
    there, which is the question this answers, and a diagnostic that has
    to name the errno asks ``miss_condition``.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): path to resolve.
    """
    stat: FileStat | None
    try:
        stat, _ = await dispatch("stat", path)
    except _ABSENT:
        stat = None
    if stat is not None:
        return stat
    try:
        entries, _ = await dispatch("readdir", path)
    except _ABSENT:
        return None
    if not entries:
        return None
    return FileStat(
        name=posixpath.basename(path.virtual.rstrip("/")),
        type=FileType.DIRECTORY,
    )


async def _stat_through(files: Files, path: str | PathSpec) -> FileStat | None:
    """``resolve_path_stat`` through the command's files.

    Args:
        files (Files): the command's files.
        path (str | PathSpec): absolute virtual path.
    """
    return await resolve_path_stat(
        files.dispatch, PathSpec.from_str_path(path, cwd="/")
    )


async def _readdir_through(files: Files, path: str) -> list[str]:
    """One directory's entries through the command's files.

    Args:
        files (Files): the command's files.
        path (str): absolute virtual path of the directory.
    """
    entries, _ = await files.dispatch(
        "readdir", PathSpec.from_str_path(path, cwd="/")
    )
    return list(entries)


def vfs_stat_path(files: Files | None) -> StatPath | None:
    """Stat one path through the command's files, which answer wherever
    it lives (a ``find -L`` start point may sit on another mount); None
    outside a workspace.

    Args:
        files (Files | None): the command's files.
    """
    return None if files is None else partial(_stat_through, files)


def vfs_readdir_path(files: Files | None) -> ReaddirPath | None:
    """List one directory through the command's files, for a walk that
    crosses a mount; None outside a workspace.

    Args:
        files (Files | None): the command's files.
    """
    return None if files is None else partial(_readdir_through, files)


async def stat_or_enoent(stat_path: StatPath, path: PathSpec) -> FileStat:
    """A dispatcher lookup in the shape a chain walk reads.

    ``StatPath`` answers None for a miss, while :func:`dot_refusal` and
    its kin read a stat that raises, so a command that holds only the
    lookup (``vfs_stat_path``) binds this with ``functools.partial``.

    Args:
        stat_path (StatPath): dispatcher-backed lookup of one path.
        path (PathSpec): the path to stat.
    """
    row = await stat_path(path)
    if row is None:
        raise enoent(path)
    return row


def virtual_key(path: PathSpec) -> PathSpec:
    """``path`` keyed by its whole virtual path, the shape a command's
    paths take: the dispatcher routes each one to its mount, so no
    command derives a mount from a path's key.

    Args:
        path (PathSpec): A path.
    """
    return replace(path, vfs_path=path.virtual.strip("/"))


def virtual_flags(flags: Mapping[str, FlagValue]) -> dict[str, FlagValue]:
    """A command's flags with every path value keyed by its whole virtual
    path (``virtual_key``): a single path (awk -f) or a list of them
    (repeated grep -f). Everything else passes through unchanged.

    Args:
        flags (Mapping[str, FlagValue]): the parsed flags.
    """
    keyed: dict[str, FlagValue] = FlagBag(flags)
    for key, value in keyed.items():
        if isinstance(value, PathSpec):
            keyed[key] = virtual_key(value)
        elif isinstance(value, list):
            keyed[key] = [
                virtual_key(item) if isinstance(item, PathSpec) else item
                for item in value
            ]
    return keyed


def spelled_from(path: PathSpec, operand: PathSpec) -> PathSpec:
    """``path`` spelled from its operand as typed, the way GNU names it.

    Args:
        path (PathSpec): A path at, under or above ``operand``.
        operand (PathSpec): The operand the command was given.
    """
    return replace(path, raw_path=operand_spelling(path.virtual, operand))


def descendant_path(root: PathSpec, virtual: str) -> PathSpec:
    """A path at, under or above ``root``, spelled the way ``root`` is.

    Args:
        root (PathSpec): The operand the path is reached from.
        virtual (str): The path's virtual path.
    """
    return spelled_from(PathSpec.from_str_path(virtual), root)


async def entry_kind(stat: StatFn, path: PathSpec) -> tuple[bool, bool]:
    """Probe a path once for ``(exists, is_dir)``.

    ENOTDIR counts as "does not exist": a path whose parent chain runs
    through a plain file cannot exist. This is the probe for a path
    that is not an operand (an ancestor in a chain walk, an overwrite
    target already paired); an operand itself goes through
    :func:`source_kind` or :func:`dest_kind`, which keep the ENOTDIR a
    slashed spelling earns. ``NotADirectoryError`` is not a
    ``FileNotFoundError`` subclass, so it has to be named explicitly.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): The probed path.
    """
    try:
        info = await stat(path)
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return False, False
    return True, info.type == FileType.DIRECTORY


async def nearest_ancestor(stat: StatFn, path: PathSpec) -> tuple[str, bool]:
    """The nearest ancestor of `path` that exists, and whether it is a
    directory.

    Walked upward from the immediate parent, as the kernel stops
    resolving at the first component it cannot pass. The mount root
    always exists as a directory and is never stat-ed: a backend that
    cannot stat "/" must not fail every operand under it.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): The path whose chain to walk.
    """
    node = parent(norm(path.virtual))
    while node != "/":
        exists, is_dir = await entry_kind(stat, descendant_path(path, node))
        if exists:
            return node, is_dir
        node = parent(node)
    return "/", True


async def is_implicit_dir(readdir: ReaddirFn, path: PathSpec) -> bool:
    """Whether a path that failed stat with ENOENT is an implicit directory.

    Keyed backends (RAM/Redis/S3) have no directory entries: stat of a
    prefix that only exists through deeper keys raises ENOENT. The operand's
    own readdir cannot serve as the probe: synthetic hierarchies fabricate
    children for any name (postgres answers ``tables/views`` for a missing
    schema) and database backends raise driver errors for missing tables.
    The parent listing is authoritative instead: the operand is an implicit
    directory only if its parent's readdir lists it. When the operand is
    the mount root there is no parent to list, so its own readdir decides
    (root listings are real in every backend). A listing that misses is a
    negative probe (the original ENOENT stands); any other failure
    propagates.

    Args:
        readdir (ReaddirFn): the caller's listing.
        path (PathSpec): The operand whose stat raised ENOENT.
    """
    target = norm(path.virtual)
    key = path.vfs_path.strip("/")
    if not key:
        try:
            entries = await readdir(path)
        except MISS_ERRORS:
            return False
        return bool(entries)
    parent_key = key.rsplit("/", 1)[0] if "/" in key else ""
    parent_virtual = parent(target)
    parent_path = PathSpec(
        virtual=parent_virtual, directory=parent_virtual, vfs_path=parent_key
    )
    try:
        entries = await readdir(parent_path)
    except MISS_ERRORS:
        return False
    return any(norm(entry) == target for entry in entries)


async def read_hit_a_dir(
    stat: StatFn,
    readdir: ReaddirFn,
    path: PathSpec,
    exc: BaseException | None,
) -> bool:
    """Whether a failed or empty read was a read of a directory.

    Asked after a failure or EOF without bytes: some drivers report an
    empty stream for directories. Nonempty reads need no extra probe.
    One that knows says so (gdrive, box, dropbox and disk raise
    IsADirectoryError), a keyed store answers ENOENT because a directory
    there is a set of keys rather than an object, and sftp answers with
    an opaque non-OSError.

    Three ways the answer can be yes, in probe-cost order. The errno
    itself costs nothing. The stat is one call, and a stat that ANSWERS
    ends the cascade either way: a file is a file, and the later probe
    only makes sense for a path stat could not see. Reaching past a
    successful stat read a rule-refused file as a directory, because its
    parent's listing names it. The parent listing is one call and is the
    only thing that can tell a missing key from a prefix that exists only
    through deeper keys.

    A no leaves the original error untouched, so nothing is swallowed:
    the caller re-raises what the backend said. Both probes are broad for
    that same reason: a probe that fails is a negative probe, never an
    error to surface. Surfacing one would replace the read's error with
    one from a call the user never made, and it is the read that failed.
    ``is_implicit_dir`` narrows to MISS_ERRORS because for its other
    caller the stat IS the operation; here it is a probe, so the wider
    catch belongs on this side of the call, and each failure it absorbs
    is logged.

    Args:
        stat (StatFn): the entry at a path itself, as lstat answers;
            raises when nothing is there.
        readdir (ReaddirFn): the caller's listing.
        path (PathSpec): the path whose read failed.
        exc (BaseException | None): the failure, or None for an empty read.
    """
    if isinstance(exc, IsADirectoryError):
        return True
    if isinstance(exc, DotWalkError):
        # The path did not resolve at all, which no reading turns into a
        # directory; its parent may well list the name it simplifies to.
        return False
    try:
        st: FileStat | None = await stat(path)
    except Exception as probe:
        logger.debug("read probe: stat %s failed: %s", path.virtual, probe)
        # Only a stat that finds nothing leaves room for a directory of
        # deeper keys. One that fails otherwise (an upstream error) proves
        # nothing, and the parent listing would name the file whose
        # backend failed.
        if not isinstance(probe, MISS_ERRORS):
            return False
        st = None
    if st is not None:
        return st.type == FileType.DIRECTORY
    try:
        if await is_implicit_dir(readdir, path):
            return True
    except Exception as probe:
        logger.debug("read probe: listing %s failed: %s", path.virtual, probe)
    return False


async def absent_dest_error(
    stat: StatFn, target: PathSpec
) -> FsCondition | None:
    """The condition a create at an absent path meets in its parent chain.

    None when the immediate parent is a directory, so the path can be
    made there; ENOTDIR when a plain file stands in the chain; ENOENT
    when a directory higher up is the nearest thing there, the
    components below it being absent. For a caller that already knows
    ``target`` is not there, which is what :func:`dest_kind` finds out
    first. Mirrors TS ``absentDestError``.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        target (PathSpec): The absent path to be created.
    """
    node, is_dir = await nearest_ancestor(stat, target)
    if not is_dir:
        return FsCondition.ENOTDIR
    if node == parent(norm(target.virtual)):
        return None
    return FsCondition.ENOENT


def link_follow(links: LinkView | None) -> Callable[[str], str] | None:
    """The link resolution a dot walk is handed, None while no link exists.

    Args:
        links (LinkView | None): the namespace's symlink facts.
    """
    return links.resolve if links is not None else None


def link_target(links: LinkView | None) -> Callable[[str], str | None] | None:
    """One link's target, the hop a canonicalizing walk reads, None
    while no link exists.

    Args:
        links (LinkView | None): the namespace's symlink facts.
    """
    if links is None:
        return None

    def target(path: str) -> str | None:
        row = links.stat_at(path)
        return None if row is None else str(row.extra[LINK_TARGET_KEY])

    return target


def _spells(
    dotted: str, virtual: str, follow: Callable[[str], str] | None
) -> bool:
    """Whether ``virtual`` is the path a dotted spelling names.

    It is the textual simplification, or that simplification taken
    through the links: the kernel walk (``follow_paths``) resolves an
    operand before its command runs, every component or all but the
    last, and the operand it hands on is still the one typed.

    Args:
        dotted (str): the typed absolute spelling.
        virtual (str): the path it rides.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, None while it holds no link.
    """
    spelled = resolve_path(dotted, "/")
    if spelled == virtual:
        return True
    if follow is None:
        return False
    head, _, name = dotted.rstrip("/").rpartition("/")
    try:
        whole = resolve_path(follow(dotted), "/")
        above = follow(head or "/")
    except CycleError:
        return False
    return virtual in (
        whole,
        resolve_path(above.rstrip("/") + "/" + name, "/"),
    )


def walk_spelling(path: PathSpec, follow: Callable[[str], str] | None) -> str:
    """The typed spelling, links before ``..``, while it names the path.

    Without a trailing slash: that is a final ``.``, which ``dot_refusal``
    proves, and a store that keeps no directories reads a slashed key as
    one, so ``cat reg/`` there was ENOENT, not ENOTDIR.

    Args:
        path (PathSpec): the path as the caller named it.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, None while it holds no link.
    """
    dotted = path.dotted
    if dotted is not None and _spells(dotted, path.virtual, follow):
        return dotted.rstrip("/") or "/"
    return path.virtual


def hidden_walk(
    path: PathSpec,
    follow: Callable[[str], str] | None,
    visible: Callable[[str], bool],
) -> OSError | None:
    """ENOENT when the walk of a path's dots looks up a name the session
    cannot see, None when it sees every one.

    ``virtual`` simplified the dots away, so a hidden name in front of
    one (``secret/../f``, a hidden link's ``lnk/../f``) is gone from the
    path the hides judge, while the walk still has to find it. It
    answers as a missing name does, and before ``dot_refusal`` proves
    anything a directory, so the refusal cannot tell a hide from an
    absence. The walk stops at the hidden name, so a link there is
    never followed.

    Args:
        path (PathSpec): the operand, ``dotted`` set by the classifier.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, None while it holds no link.
        visible (Callable[[str], bool]): whether the session sees a path.
    """
    dotted = path.dotted
    if dotted is None or not _spells(
        dotted, resolve_path(path.virtual, "/"), follow
    ):
        return None
    name = path.raw_path or path.virtual
    try:
        for looked in dot_lookups(dotted, follow):
            if not visible(looked):
                return dot_walk_error(name, FsCondition.ENOENT)
    except CycleError:
        return eloop(name)
    return None


async def dot_refusal(
    stat: StatFn,
    path: PathSpec,
    follow: Callable[[str], str] | None = None,
    creates: bool = False,
) -> OSError | None:
    """What a path's dot components answer, None when every one resolves.

    The kernel resolves ``.`` and ``..`` against the directory they sit
    in, so a walk through a missing name fails ENOENT and one through a
    plain file ENOTDIR (``cat nope/../f``, ``cat f.txt/.``), where the
    textual simplification in ``virtual`` reached ``f`` regardless. Each
    name in front of a dot is proved a directory, in walk order, and one
    that is not is judged by its chain the way a create is, so a miss
    under a plain file is ENOTDIR on every store. A link in front of a
    dot is followed first, as the kernel walks (only bash's ``cd`` reads
    ``link/..`` logically). A trailing slash is a final ``.``: an
    existing name in front of it has to be a directory too (``cat
    reg/``); a call that creates that name answers EEXIST instead
    (``mkdir reg/``), however the store keeps the name.

    Only the path the spelling names is walked: a path derived from it
    (a child a walker builds, a respelled match) carries the field along
    but no longer spells it, while the operand the kernel walk followed
    through a link (``lnk/nope/../f``) still does. The error names the
    operand as typed and is a ``DotWalkError``, final for every layer
    that re-reads a miss.

    Args:
        stat (StatFn): Stats a path through the workspace, following
            links; raises when nothing is there.
        path (PathSpec): The operand, ``dotted`` set by the classifier.
        follow (Callable[[str], str] | None): the namespace's link
            resolution, so an operand already followed is still walked.
        creates (bool): the call creates the final name (mkdir,
            symlink), so a plain file behind a trailing slash is EEXIST.
    """
    dotted = path.dotted
    if dotted is None or not _spells(
        dotted, resolve_path(path.virtual, "/"), follow
    ):
        return None
    name = path.raw_path or path.virtual
    proved: list[str] = []
    try:
        prefixes = dot_prefixes(dotted, follow)
    except CycleError:
        return eloop(name)
    for prefix in prefixes:
        if any(done.startswith(prefix + "/") for done in proved):
            continue
        spec = PathSpec.from_str_path(prefix)
        exists, is_dir = await entry_kind(stat, spec)
        if exists and is_dir:
            proved.append(prefix)
            continue
        if not exists and (await nearest_ancestor(stat, spec))[1]:
            return dot_walk_error(name, FsCondition.ENOENT)
        return dot_walk_error(name, FsCondition.ENOTDIR)
    if dotted.endswith("/"):
        exists, is_dir = await entry_kind(
            stat, PathSpec.from_str_path(path.virtual)
        )
        if exists and not is_dir:
            if creates:
                return eexist(name)
            return dot_walk_error(name, FsCondition.ENOTDIR)
    return None

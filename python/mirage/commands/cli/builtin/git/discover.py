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

from dataclasses import replace

from mirage.commands.cli.builtin.git.constants import GIT_DIR
from mirage.commands.cli.builtin.git.errors import (
    InvalidGitFileError,
    NotARepositoryError,
    NotAWorkTreeError,
    NoWorkingDirectoryError,
    WorkTreeChdirError,
)
from mirage.commands.cli.builtin.git.io import read_file, read_optional
from mirage.commands.cli.builtin.git.repo import config_bool, config_values
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.ops.types import MountRoot, StatPath
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.utils.path import join_spec, parent_spec, typed_spec

GITDIR_PREFIX = "gitdir:"
COMMON_DIR = "commondir"


async def _follow_gitfile(
    dispatch: DispatchFn, stat_path: StatPath, gitfile: PathSpec
) -> PathSpec:
    """Read a ``.git`` file and return the directory it points at.

    A ``.git`` that is a file rather than a directory holds one
    ``gitdir: <path>`` line. git writes one for every linked worktree
    (``git worktree add``) and every submodule, so the real git
    directory sits outside the tree being worked in, and reading the
    file as if it were a directory is how this used to fail.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        gitfile (PathSpec): absolute virtual path of the ``.git`` file.
    """
    text = (await read_file(dispatch, gitfile)).decode(
        "utf-8", errors="replace"
    )
    line = text.strip()
    if not line.startswith(GITDIR_PREFIX):
        raise InvalidGitFileError(gitfile.virtual)
    target = line[len(GITDIR_PREFIX) :].strip()
    if not target:
        raise InvalidGitFileError(gitfile.virtual)
    resolved = typed_spec(target, parent_spec(gitfile))
    if await stat_path(resolved) is None:
        # An absolute pointer names a path on the backend's own
        # filesystem, which is only reachable when the mount happens to
        # span it: a worktree mounted alone cannot see the repository it
        # was cut from. git says the same thing when the target is gone.
        raise NotARepositoryError(resolved.virtual, quoted=False)
    return resolved


async def _common_dir(dispatch: DispatchFn, gitdir: PathSpec) -> PathSpec:
    """The shared git directory behind a per-worktree one.

    A linked worktree's git directory carries a ``commondir`` file
    naming the repository it belongs to, usually as ``../..``. Objects,
    packed-refs and branches live there; only HEAD and the index are
    the worktree's own. An ordinary checkout has no such file and is its
    own common directory.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (PathSpec): absolute virtual path of the git directory.
    """
    data = await read_optional(dispatch, join_spec(gitdir, COMMON_DIR))
    if data is None:
        return gitdir
    target = data.decode("utf-8", errors="replace").strip()
    return typed_spec(target, gitdir) if target else gitdir


async def _validated(
    dispatch: DispatchFn, stat_path: StatPath, gitdir: PathSpec
) -> PathSpec | None:
    """git's ``is_git_directory``: the common directory, or None.

    A git directory holds its own HEAD and finds objects and refs in its
    common directory, which is itself unless it is a linked worktree's.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        gitdir (PathSpec): absolute virtual path of the candidate.
    """
    common = await _common_dir(dispatch, gitdir)
    signatures = (
        (join_spec(gitdir, "HEAD"), FileType.FILE),
        (join_spec(common, "objects"), FileType.DIRECTORY),
        (join_spec(common, "refs"), FileType.DIRECTORY),
    )
    for path, kind in signatures:
        entry = await stat_path(path)
        if entry is None or entry.type is not kind:
            return None
    return common


async def discover(
    dispatch: DispatchFn,
    stat_path: StatPath,
    mount_root: MountRoot,
    start: PathSpec,
    gitdir: PathSpec | None = None,
    worktree: PathSpec | None = None,
) -> RepoLocation:
    """Find the repository governing a path, or raise git's own fatal.

    Walks up from ``start`` looking for a ``.git`` entry, stopping at the
    mount root. Real git stops discovery at a filesystem boundary unless
    GIT_DISCOVERY_ACROSS_FILESYSTEM is set, and a mount prefix is exactly
    that boundary: crossing it would probe a different backend for a
    repository that has nothing to do with the operand.

    Existence comes from ``stat_path`` rather than one backend's stat
    because on a prefix store a directory is not an object: ``.git``
    answers on readdir while a point lookup misses it entirely. That is
    the same fact ``find`` asks about its own start point.

    What is found is not always the git directory. A ``.git`` file
    points at one elsewhere, and the directory it points at may share
    its objects with another, so the three paths are resolved here and
    carried separately rather than derived again by each verb.

    Args:
        dispatch (DispatchFn): workspace op dispatcher, for the two files
            that redirect a git directory.
        stat_path (StatPath): dispatcher-backed stat asking both channels
            a backend can answer on; None means nothing is there.
        mount_root (MountRoot): the mount prefix serving a path.
        start (PathSpec): absolute virtual path to start from, normally the
            session cwd or the argument of ``-C``.
        gitdir (PathSpec | None): explicit repository path; keeps the typed
            spelling for refusals and skips upward discovery.
        worktree (PathSpec | None): explicit working tree, relative to start.
    """
    root = typed_spec(mount_root(start.virtual), "/")
    if gitdir is not None:
        here = await stat_path(start)
        if here is None:
            raise NoWorkingDirectoryError(
                start.raw_path if start.dotted else start.virtual
            )
        if here.type is not FileType.DIRECTORY:
            raise NoWorkingDirectoryError(
                start.raw_path if start.dotted else start.virtual,
                "Not a directory",
            )
        candidate = gitdir
        info = await stat_path(candidate)
        if info is None:
            raise NotARepositoryError(gitdir.raw_path)
        # git names the target a pointer leads to unquoted, as it does for
        # one met on the way up.
        pointer = info.type is not FileType.DIRECTORY
        resolved = (
            await _follow_gitfile(dispatch, stat_path, candidate)
            if pointer
            else candidate
        )
        common = await _validated(dispatch, stat_path, resolved)
        if common is None:
            raise (
                NotARepositoryError(resolved.virtual, quoted=False)
                if pointer
                else NotARepositoryError(gitdir.raw_path)
            )
        return await _location(
            dispatch, stat_path, resolved, common, start, worktree, root
        )
    current = start
    first = True
    while True:
        candidate = join_spec(current, GIT_DIR)
        info = await stat_path(candidate)
        if info is not None:
            gitdir = (
                candidate
                if info.type is FileType.DIRECTORY
                else await _follow_gitfile(dispatch, stat_path, candidate)
            )
            common = await _common_dir(dispatch, gitdir)
            return await _location(
                dispatch,
                stat_path,
                gitdir,
                common,
                current,
                worktree,
                root,
            )
        if first:
            # git enters ``-C`` before it looks for anything, so a path it
            # cannot enter fails on its own terms even when a directory
            # above it holds a repository. A file counts as one it cannot
            # enter: tolerating it would walk up and run in the parent
            # repository, which for a write verb means mutating a
            # repository the caller did not name. Asked only after the
            # first probe missed, because a hit already proves the
            # directory is there.
            here = await stat_path(current)
            if here is None:
                raise NoWorkingDirectoryError(
                    start.raw_path if start.dotted else start.virtual
                )
            if here.type is not FileType.DIRECTORY:
                raise NoWorkingDirectoryError(
                    start.raw_path if start.dotted else start.virtual,
                    "Not a directory",
                )
            first = False
        if current.virtual == root.virtual or current.virtual == "/":
            raise NotARepositoryError()
        current = parent_spec(current)


async def _location(
    dispatch: DispatchFn,
    stat_path: StatPath,
    gitdir: PathSpec,
    common: PathSpec,
    default_worktree: PathSpec,
    worktree: PathSpec | None,
    root: PathSpec,
) -> RepoLocation:
    """Resolve the work tree once for every verb, after locating metadata.

    CLI/environment paths are relative to -C; core.worktree is relative
    to the git directory, as in native git 2.54.0, which enters a relative
    one before any verb runs. A bare repository keeps the default, and
    only a verb that needs a work tree refuses it (``require_work_tree``).
    git parses core.bare whichever tree wins, so a value it cannot read
    fails every verb, a named work tree and a linked worktree included.
    Divergence: the ``config.worktree`` that ``extensions.worktreeConfig``
    adds is not read, so a linked worktree never takes either key; and a
    bare repository that also names a core.worktree stays bare without
    git's "do not make sense" warning.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        gitdir (PathSpec): resolved checkout metadata directory.
        common (PathSpec): shared repository directory.
        default_worktree (PathSpec): discovered root, or start for explicit gitdir.
        worktree (PathSpec | None): command-line or environment override.
        root (PathSpec): mount boundary used for discovery.

    Raises:
        BadConfigValueError: a core.bare git cannot read as a boolean.
        WorkTreeChdirError: a relative core.worktree git cannot enter.
    """
    located = RepoLocation(gitdir, common, default_worktree, root)
    bare = await config_bool(dispatch, located, b"core", b"bare", False)
    if worktree is not None:
        return replace(located, worktree=worktree)
    if gitdir.virtual != common.virtual or bare:
        return located
    configured = await config_values(dispatch, located, b"core", b"worktree")
    if not configured:
        return located
    spelled = configured[-1].decode("utf-8", errors="replace")
    selected = typed_spec(spelled, gitdir)
    if not spelled.startswith("/"):
        info = await stat_path(selected)
        if info is None:
            raise WorkTreeChdirError(spelled)
        if info.type is not FileType.DIRECTORY:
            raise WorkTreeChdirError(spelled, "Not a directory")
    return replace(located, worktree=selected)


async def is_bare(dispatch: DispatchFn, location: RepoLocation) -> bool:
    """Whether core.bare leaves the repository without a work tree.

    git reads core.bare, like core.worktree, only from a repository's own
    config, and a linked worktree's config is its repository's, so a
    linked worktree is never bare. A named work tree overrides it.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        location (RepoLocation): the discovered repository.
    """
    return (
        location.gitdir.virtual == location.commondir.virtual
        and await config_bool(dispatch, location, b"core", b"bare", False)
    )


async def require_work_tree(
    dispatch: DispatchFn,
    stat_path: StatPath,
    location: RepoLocation,
    named: bool,
) -> None:
    """git's ``setup_work_tree``: refuse when there is no tree to enter.

    Asked by every verb that reads or writes working files, so a bare
    repository or a mistyped ``--work-tree`` is refused rather than read
    as a tree with every file deleted.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        location (RepoLocation): the discovered repository.
        named (bool): ``--work-tree`` or ``GIT_WORK_TREE`` chose the tree.

    Raises:
        NotAWorkTreeError: the repository is bare or the tree is not a
            directory.
    """
    if not named and await is_bare(dispatch, location):
        raise NotAWorkTreeError()
    info = await stat_path(location.worktree)
    if info is None or info.type is not FileType.DIRECTORY:
        raise NotAWorkTreeError()

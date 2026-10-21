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

import errno
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.discover import (
    discover,
    require_work_tree,
)
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    IndexLockError,
)
from mirage.commands.cli.builtin.git.repo import (
    Repo,
    config_values,
    open_repo,
)
from mirage.commands.cli.builtin.git.types import ReadOnlyRefusal, RepoLocation
from mirage.commands.cli.builtin.git.util import (
    fatal,
    git_bool,
    require_vfs,
    start_point,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec

# The ambiguity warnings the running invocation collects, None when
# nothing collects them.
AMBIGUOUS: ContextVar[list[str] | None] = ContextVar("AMBIGUOUS", default=None)
# The repository the running invocation opened, for the refusal a
# read-only mount gets in git's words.
LOCATIONS: ContextVar[RepoLocation | None] = ContextVar(
    "LOCATIONS", default=None
)


def index_locked(
    texts: list[str], ctx: Context, location: RepoLocation | None
) -> GitError:
    """The refusal of every verb whose first write is the index's.

    Args:
        texts (list[str]): the line's operands.
        ctx (Context): the line's context.
        location (RepoLocation | None): the repository it opened.
    """
    return IndexLockError(
        location.gitdir.virtual if location is not None else ".git"
    )


def git_would_refuse(
    ctx: Context, location: RepoLocation | None, path: str | None
) -> bool:
    """Whether a write a read-only mount refused is one git is refused
    first, on the lock in its own directory.

    git takes that lock before it touches anything else, so a refused
    write on the mount holding the git directory, or before any
    repository was opened (clone and init make their directory first),
    is git's lock refusal. One elsewhere, a work tree on a read-only
    mount of its own, is not, and keeps its own error.

    Args:
        ctx (Context): the line's context, whose files hold the mounts.
        location (RepoLocation | None): the repository it opened.
        path (str | None): where the refused write went.
    """
    if location is None or not path:
        return True
    vfs = ctx.vfs
    root = (
        vfs.mount_of(location.commondir) if vfs is not None else None
    ) or "/"
    return any(
        path == base or path.startswith(f"{base.rstrip('/')}/")
        for base in (root, location.gitdir.virtual)
    )


def verb(
    fn: Callable[
        [Accessor, list[PathSpec], list[str], Context],
        Awaitable[tuple[ByteSource | None, IOResult]],
    ],
    refused: ReadOnlyRefusal | None = None,
) -> Callable[
    [Accessor, list[PathSpec], list[str], Context],
    Awaitable[tuple[ByteSource | None, IOResult]],
]:
    """A git verb whose fatal errors are rendered as git renders them,
    whose ``refname is ambiguous`` warnings reach stderr, and whose
    refusal by a read-only mount is in git's words.

    Every ``GitError`` a verb raises is rendered here (``fatal``), so no
    verb catches one to render it. git prints the warning where it
    resolves the name, ahead of anything the verb says after; each
    invocation gets a list of its own here, resolution adds to it, and
    the lines go in front of the verb's own stderr. A write a read-only
    mount turns down fails before anything is written, so the verb's own
    refusal stands in for it: git's lock on the index or on the ref it
    was about to write.

    Args:
        fn: the verb.
        refused (ReadOnlyRefusal | None): the refusal git gives the verb
            on a read-only filesystem, None for a verb that only reads.
    """

    async def run(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        lines: list[str] = []
        warned = AMBIGUOUS.set(lines)
        placed = LOCATIONS.set(None)
        try:
            try:
                out, io = await fn(accessor, paths, texts, ctx)
            except GitError as exc:
                out, io = fatal(exc)
            except OSError as exc:
                location = LOCATIONS.get()
                if (
                    refused is None
                    or exc.errno != errno.EROFS
                    or not git_would_refuse(ctx, location, exc.filename)
                ):
                    raise
                out, io = fatal(refused(texts, ctx, location))
        finally:
            AMBIGUOUS.reset(warned)
            LOCATIONS.reset(placed)
        if lines:
            io.stderr = "".join(lines).encode() + await materialize(io.stderr)
        return out, io

    return run


async def opened(
    ctx: Context, fl: FlagView, work_tree: bool = False
) -> tuple[Repo, RepoLocation]:
    """Discover and open the repository a verb was invoked against.

    Every verb starts the same way: honor ``-C``, walk up to the mount
    root looking for a ``.git``, then pull the object database across
    the dispatcher. Kept in one place so a new verb inherits the
    discovery rules rather than restating them, and so the refusal a
    verb owes outside a workspace is written once.

    The mount root is the session's files' ``mount_of``, the same
    answer a runtime's guest gets.

    Args:
        ctx (Context): the line's context, one field per state plane.
        fl (FlagView): the leaf's flag bag, read for ``-C``,
            ``--git-dir`` and ``--work-tree``.
        work_tree (bool): the verb reads or writes working files, so
            there must be a work tree to enter, as git's
            ``NEED_WORK_TREE`` asks.

    Raises:
        NotAWorkTreeError: no files are wired, or ``work_tree`` and there
            is none to enter.
    """
    location = await located(ctx, fl)
    vfs = ctx.vfs
    assert vfs is not None
    LOCATIONS.set(location)
    if work_tree:
        named = fl.as_path("work_tree") is not None
        await require_work_tree(vfs, location, named)
    warn = git_bool(
        await config_values(vfs, location, b"core", b"warnambiguousrefs"),
        "core.warnambiguousrefs",
        True,
    )
    repo = await open_repo(vfs, location, AMBIGUOUS.get() if warn else None)
    return repo, location


async def located(ctx: Context, fl: FlagView) -> RepoLocation:
    """Locate a repository without opening potentially damaged objects.

    Args:
        ctx (Context): the line's context, whose files git reads.
        fl (FlagView): repository-selection flags.
    """
    vfs = require_vfs(ctx)
    chosen = fl.as_path("work_tree")
    gitdir = fl.as_path("git_dir")
    location = await discover(vfs, start_point(fl), gitdir, chosen)
    return replace(location, vfs=vfs)

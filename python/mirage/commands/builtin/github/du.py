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

from collections.abc import Awaitable, Callable
from functools import partial

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import du_generic
from mirage.commands.builtin.generic_bind.adapter import (
    mount_io,
    with_command_guards,
)
from mirage.commands.builtin.generic_bind.builders.du import (
    WalkBudget,
    walk_entries,
    walk_size,
)
from mirage.commands.builtin.github.pushdown import resolve_glob
from mirage.commands.config import CommandIO, CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.core.github.stat import stat
from mirage.core.github.tree import ensure_tree
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.view.namespace_view import paths_scoped
from mirage.view.types import NamespaceView


def _subtree(
    accessor: GitHubAccessor, path: PathSpec
) -> tuple[list[tuple[str, int]], list[str]]:
    """Every blob and every directory at or under ``path``.

    Read off the git tree rather than the index, mirroring TypeScript's
    du: the tree is keyed repo-relative, which is the space these
    comparisons are in, so both come back mount-relative. A blob of
    unknown size counts 0, as the walked du counts any file. A directory
    comes back on its own because one holding no blob (only a submodule,
    which the tree drops) still gets du's 0 row.

    Args:
        accessor (GitHubAccessor): backend handle holding the tree.
        path (PathSpec): subtree root.
    """
    key = path.vfs_path.strip("/")
    prefix = key + "/" if key else ""
    blobs: list[tuple[str, int]] = []
    directories: list[str] = []
    for p, entry in accessor.tree.items():
        if p != key and not p.startswith(prefix):
            continue
        if entry.type == "blob":
            blobs.append(("/" + p, entry.size or 0))
        else:
            directories.append("/" + p)
    blobs.sort()
    return blobs, directories


async def _resolve(
    live: Callable[[], Awaitable[None]],
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    targets: list[PathSpec],
) -> list[PathSpec]:
    await live()
    return await resolve_glob(accessor, targets, index)


async def _stat(
    live: Callable[[], Awaitable[None]],
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    path: PathSpec,
):
    await live()
    return await stat(accessor, path, index)


def _walked(
    accessor: GitHubAccessor, ns: NamespaceView | None, path: PathSpec
) -> bool:
    """Whether du walks the subtree through the command guards rather
    than summing the tree it already holds.

    Args:
        accessor (GitHubAccessor): backend handle.
        ns (NamespaceView | None): the command's namespace view.
        path (PathSpec): the operand being sized.
    """
    return accessor.truncated or paths_scoped(ns, [path])


async def _live_size(
    io: CommandIO,
    live: Callable[[], Awaitable[None]],
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    ns: NamespaceView | None,
    path: PathSpec,
) -> int:
    await live()
    # A truncated tree names only some paths and is never refetched, so it
    # is walked folder by folder, as a backend with no tree would be; so
    # is a subtree under a hide or a path rule, whose raw sum would count
    # what the session cannot see and never report a refused directory.
    if _walked(accessor, ns, path):
        return await walk_size(
            with_command_guards(io),
            accessor,
            index,
            budget,
            path,
        )
    blobs, _ = _subtree(accessor, path)
    return sum(size for _, size in blobs)


async def _live_entries(
    io: CommandIO,
    live: Callable[[], Awaitable[None]],
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    ns: NamespaceView | None,
    path: PathSpec,
) -> tuple[list[tuple[str, int]], int]:
    await live()
    if _walked(accessor, ns, path):
        return await walk_entries(
            with_command_guards(io),
            accessor,
            index,
            budget,
            path,
        )
    blobs, directories = _subtree(accessor, path)
    mount = mount_prefix_of(path.virtual, path.vfs_path)
    budget.directories.extend(mount + d for d in directories)
    return blobs, sum(size for _, size in blobs)


@command("du", vfs="github", spec=SPECS["du"])
async def du(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    checked = False
    io = mount_io(opts)
    budget = WalkBudget(io.max_du_entries)

    # `_subtree` reads accessor.tree rather than the index, so the first
    # callback brings the tree live, after du has validated its flags: an
    # invalid line must cost no fetch. Once per line, so one du reads one
    # tree and a Redis index pays one round trip.
    async def live() -> None:
        nonlocal checked
        if not checked:
            await ensure_tree(accessor, opts.index, opts.mount_prefix)
            checked = True

    return await du_generic(
        paths,
        list(texts),
        opts,
        partial(_resolve, live, accessor, opts.index),
        partial(_stat, live, accessor, opts.index),
        partial(_live_size, io, live, accessor, opts.index, budget, opts.ns),
        partial(
            _live_entries, io, live, accessor, opts.index, budget, opts.ns
        ),
        truncated=lambda: budget.hit,
        unreadable=lambda: budget.unreadable,
        directories=lambda: budget.directories,
    )

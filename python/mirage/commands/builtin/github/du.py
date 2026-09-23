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

from functools import partial

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import du_generic
from mirage.commands.builtin.github._provision import metadata_provision
from mirage.commands.builtin.github.io import IO, resolve_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github.tree import ensure_tree
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


def _subtree(accessor: GitHubAccessor,
             path: PathSpec) -> list[tuple[str, int]]:
    """Every sized entry at or under ``path``, in mount-relative space.

    Read off the git tree rather than the index, mirroring TypeScript's
    du: the tree is keyed repo-relative, which is the space these
    comparisons are in.

    Args:
        accessor (GitHubAccessor): backend handle holding the tree.
        path (PathSpec): subtree root.
    """
    key = path.vfs_path.strip("/")
    prefix = key + "/" if key else ""
    found = [("/" + p, entry.size) for p, entry in accessor.tree.items()
             if (p == key or p.startswith(prefix)) and entry.size is not None]
    found.sort()
    return found


async def _du_size(accessor: GitHubAccessor, path: PathSpec) -> int:
    return sum(size for _, size in _subtree(accessor, path))


async def _du_entries(accessor: GitHubAccessor,
                      path: PathSpec) -> tuple[list[tuple[str, int]], int]:
    found = _subtree(accessor, path)
    return found, sum(size for _, size in found)


async def du_provision(accessor: GitHubAccessor, paths: list[PathSpec],
                       texts: list[str], opts: CommandOpts) -> ProvisionResult:
    return await metadata_provision("du " + " ".join(
        p.virtual if isinstance(p, PathSpec) else p for p in paths))


async def _resolve(accessor: GitHubAccessor, index: IndexCacheStore,
                   targets: list[PathSpec]) -> list[PathSpec]:
    return await resolve_glob(accessor, targets, index)


async def _stat(accessor: GitHubAccessor, index: IndexCacheStore,
                path: PathSpec):
    return await IO.stat(accessor, path, index)


@command("du", vfs="github", spec=SPECS["du"], provision=du_provision)
async def du(accessor: GitHubAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    # `_subtree` reads accessor.tree directly rather than the index, so
    # the tree has to be hydrated first; the mount is built without it.
    await ensure_tree(accessor, opts.index, opts.mount_prefix)
    return await du_generic(paths, list(texts), opts,
                            partial(_resolve, accessor, opts.index),
                            partial(_stat, accessor, opts.index),
                            partial(_du_size, accessor),
                            partial(_du_entries, accessor))

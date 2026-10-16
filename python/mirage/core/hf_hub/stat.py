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

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.lookup import refusals_denied
from mirage.core.hf_hub.repo import head_commit, mount_version
from mirage.core.hf_hub.tree import fetch_path, fetch_tree, row_of, tree_rows
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec

log = logging.getLogger(__name__)


async def stat(
    accessor: HfHubAccessor,
    path_spec: PathSpec,
    entry: FileStat | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat one path in the repository.

    A path answers with its row, as its folder's listing names it. The
    gate's check is handed no listed row, so it asks for the one path with
    one paths-info request rather than walking the whole tree; its row
    carries the oid a tree row does.

    Args:
        accessor (HfHubAccessor): backend handle.
        path_spec (PathSpec): the path to stat.
        entry (FileStat | None): the path's row.
        index (IndexCacheStore): the store the stat runs under.

    Returns:
        FileStat: the rendered stat.

    Raises:
        FileNotFoundError: nothing exists at the path.
        PermissionError: the Hub declined to show the repository.
    """
    rel = path_spec.mount_path.strip("/")
    if not rel:
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            fingerprint=await _root_version(accessor, index),
        )
    if entry is not None:
        return entry
    if not isinstance(index, ListingCheckStore):
        raise enoent(path_spec.virtual)
    with refusals_denied(path_spec):
        found = (await fetch_path(accessor, rel)).get(rel)
    if found is None:
        raise enoent(path_spec.virtual)
    return row_of(found, rel.rsplit("/", 1)[-1])


async def tree(
    accessor: HfHubAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every entry under a directory of the repository, each as its row,
    from the one paged walk of the Hub's tree API with ``recursive=true``
    that a listing takes, at the commit the revision's head names, as a
    listing walks it. None when ``path`` is no directory in it, so the
    walk's readdir reports what is there.

    Args:
        accessor (HfHubAccessor): backend handle.
        path (PathSpec): the directory.

    Raises:
        PermissionError: the Hub declined to show the repository.
    """
    rel = path.mount_path.strip("/")
    with refusals_denied(path):
        head = await head_commit(accessor) or None
        folders = tree_rows(await fetch_tree(accessor, head))
    if rel not in folders:
        return None
    lead = rel + "/" if rel else ""
    found: dict[str, FileStat] = {}
    for folder, rows in folders.items():
        if folder != rel and not folder.startswith(lead):
            continue
        base = folder[len(lead) :]
        for row in rows:
            found[f"{base}/{row.name}" if base else row.name] = row
    return found


async def _root_version(
    accessor: HfHubAccessor,
    index: IndexCacheStore,
) -> str | None:
    """The version of the whole mount: the head commit its revision is at.

    Only the gate's ``ListingCheckStore`` asks for it, with one small
    request. Every other index (the mount's own, the null index) names no
    version and reads nothing, neither the index nor the Hub, so a getattr
    of the root never pays a check or a store round trip: nothing reads a
    root fingerprint off a mount-view stat. Nothing here refills the index
    or loads the tree: a refused head names no version rather than falling
    into a lookup.

    Args:
        accessor (HfHubAccessor): the mount's accessor.
        index (IndexCacheStore): the index the stat was asked through.

    Returns:
        str | None: the head commit sha, joined with the key prefix as
        ``mount_version`` joins it, or None when it is not asked for or
        not known.
    """
    if not isinstance(index, ListingCheckStore):
        return None
    try:
        return mount_version(await head_commit(accessor), accessor.key_prefix)
    except HfHubError as exc:
        log.debug("head of %s not answered: %s", accessor.repo_id, exc)
        return None

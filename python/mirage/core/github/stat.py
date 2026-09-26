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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.github.lookup import lookup_retrying, point_lookup
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of


def stat_of(entry: IndexEntry) -> FileStat:
    """Render one tree row as a FileStat, the same from either route.

    Args:
        entry (IndexEntry): the row for the path.

    Returns:
        FileStat: the rendered stat.
    """
    if entry.resource_type == "folder":
        return FileStat(name=entry.name, type=FileType.DIRECTORY)
    return FileStat(
        name=entry.name,
        size=entry.size,
        type=FileType.FILE,
        content=content_type_for_path(entry.name),
        fingerprint=entry.id,
        extra={"sha": entry.id},
    )


async def stat(
    accessor: GitHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat one path in the repository.

    Args:
        accessor (GitHubAccessor): backend handle.
        path_spec (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index.

    Returns:
        FileStat: the rendered stat.

    Raises:
        FileNotFoundError: nothing exists at the path.
    """
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    rel = path_spec.mount_path.strip("/")
    if not rel:
        return FileStat(name="/", type=FileType.DIRECTORY)
    key = prefix + "/" + rel if prefix else "/" + rel
    # A probe through a throwaway index asks for this one path; everything
    # else answers from the mount's listing, filling it if need be.
    found = await point_lookup(accessor, index, prefix, rel)
    if found is None:
        found = await lookup_retrying(accessor, index, prefix, key)
    if found.entry is None:
        raise enoent(virtual)
    return stat_of(found.entry)

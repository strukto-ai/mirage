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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hf_hub.lookup import dir_stat_entry, key_of, lookup
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of

log = logging.getLogger(__name__)


def stat_of(entry: IndexEntry) -> FileStat:
    """Render one tree row as a FileStat.

    Size is the row's, which is the Hub's *content* length even for an
    LFS file; the 135-byte pointer never reaches here. Reporting the
    pointer would make `wc -c` and `ls -l` lie and risk truncated copies
    over FUSE, which is the rule ``FileStat.size`` exists to keep.

    ``modified`` is None unless the mount asked for commit expansion:
    a Hub file's only mtime is the commit that last touched it, and
    stamping the repository's own lastModified onto every file would be
    a confident lie about files that commit never touched.

    Args:
        entry (IndexEntry): the row for the path.

    Returns:
        FileStat: the rendered stat.
    """
    if entry.resource_type == "folder":
        return FileStat(name=entry.name,
                        type=FileType.DIRECTORY,
                        modified=entry.remote_time or None)
    return FileStat(
        name=entry.name,
        size=entry.size,
        modified=entry.remote_time or None,
        type=FileType.FILE,
        content=content_type_for_path(entry.name),
        # git is content-addressed, so the object id is the strongest
        # fingerprint any backend here has: identical bytes carry an
        # identical oid, and a rewrite that changed nothing correctly
        # reports nothing.
        fingerprint=entry.id,
        extra=dict(entry.extra),
    )


async def stat(
    accessor: HfHubAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat one path in the repository.

    Args:
        accessor (HfHubAccessor): backend handle.
        path_spec (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index.

    Returns:
        FileStat: the rendered stat.

    Raises:
        FileNotFoundError: nothing exists at the path.
    """
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    rel = path_spec.mount_path.strip("/")
    if not rel:
        return FileStat(name="/", type=FileType.DIRECTORY)
    key = key_of(prefix, rel)
    found = await lookup(accessor, index, prefix, key)
    if found.entry is not None:
        return stat_of(found.entry)
    # A directory the tree implies but has no row of its own for still
    # exists, which is what a listing at the key proves.
    if found.children is not None:
        return stat_of(dir_stat_entry(key))
    raise enoent(path_spec.virtual)

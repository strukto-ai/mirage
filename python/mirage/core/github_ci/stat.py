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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.github_ci.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)

VIRTUAL_DIRS = {"workflows", "runs", "jobs", "artifacts"}


async def _lookup_with_fallback(
    accessor: GitHubCIAccessor,
    virtual_key: str,
    prefix: str,
    index: IndexCacheStore,
):
    result = await index.get(virtual_key)
    if result.entry is not None:
        return result
    parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
    try:
        await _readdir(
            accessor,
            PathSpec(virtual=parent_virtual,
                     directory=parent_virtual,
                     resource_path=mount_key(parent_virtual, prefix)),
            index=index,
        )
    except Exception as exc:
        # best-effort cache populate; canonical ENOENT raised below
        logger.debug("stat populate failed for %s: %s", virtual_key, exc)
    return await index.get(virtual_key)


async def stat(
    accessor: GitHubCIAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    parts = key.split("/")
    virtual_key = prefix + "/" + key

    if len(parts) == 1 and parts[0] in VIRTUAL_DIRS:
        return FileStat(name=parts[0], type=FileType.DIRECTORY)

    if len(parts) == 2 and parts[0] == "workflows" and parts[1].endswith(
            ".json"):
        if index is None:
            raise enoent(virtual)
        lookup = await _lookup_with_fallback(accessor, virtual_key, prefix,
                                             index)
        if lookup.entry is None:
            raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.JSON,
            modified=lookup.entry.remote_time or None,
            extra={"workflow_id": lookup.entry.id},
        )

    if len(parts) == 2 and parts[0] == "runs":
        if index is None:
            raise enoent(virtual)
        lookup = await _lookup_with_fallback(accessor, virtual_key, prefix,
                                             index)
        if lookup.entry is None:
            raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.DIRECTORY,
            modified=lookup.entry.remote_time or None,
            extra={"run_id": lookup.entry.id},
        )

    if len(parts) == 3 and parts[0] == "runs" and parts[2] in VIRTUAL_DIRS:
        return FileStat(name=parts[2], type=FileType.DIRECTORY)

    if len(parts) == 3 and parts[0] == "runs" and parts[2] == "run.json":
        return FileStat(name="run.json", type=FileType.JSON)

    if (len(parts) == 3 and parts[0] == "runs"
            and parts[2] == "annotations.jsonl"):
        return FileStat(name="annotations.jsonl", type=FileType.TEXT)

    if (len(parts) == 4 and parts[0] == "runs" and parts[2] == "jobs"
            and parts[3].endswith(".json")):
        if index is None:
            raise enoent(virtual)
        lookup = await _lookup_with_fallback(accessor, virtual_key, prefix,
                                             index)
        if lookup.entry is None:
            raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.JSON,
            modified=lookup.entry.remote_time or None,
            extra={"job_id": lookup.entry.id},
        )

    if (len(parts) == 4 and parts[0] == "runs" and parts[2] == "jobs"
            and parts[3].endswith(".log")):
        if index is None:
            raise enoent(virtual)
        lookup = await _lookup_with_fallback(accessor, virtual_key, prefix,
                                             index)
        if lookup.entry is None:
            raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.TEXT,
            modified=lookup.entry.remote_time or None,
            extra={"job_id": lookup.entry.id},
        )

    if (len(parts) == 4 and parts[0] == "runs" and parts[2] == "artifacts"):
        if index is None:
            raise enoent(virtual)
        lookup = await _lookup_with_fallback(accessor, virtual_key, prefix,
                                             index)
        if lookup.entry is None:
            raise enoent(virtual)
        return FileStat(
            name=lookup.entry.vfs_name or lookup.entry.name,
            type=FileType.ZIP,
            size=lookup.entry.size,
            modified=lookup.entry.remote_time or None,
            extra={"artifact_id": lookup.entry.id},
        )

    raise enoent(virtual)

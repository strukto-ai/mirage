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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.linear.readdir import readdir as _readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)

VIRTUAL_DIRS = {"", "teams"}


async def _populate_via_parent(
    accessor: LinearAccessor,
    idx_key: str,
    prefix: str,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    parent_idx = idx_key.rsplit("/", 1)[0] or "/"
    parent_path = (prefix + parent_idx) if prefix else parent_idx
    try:
        await _readdir(
            accessor,
            PathSpec(virtual=parent_path,
                     directory=parent_path,
                     resource_path=mount_key(parent_path, prefix)),
            index=index,
        )
    except FileNotFoundError as exc:
        logger.debug("stat populate failed for %s: %s", idx_key, exc)


async def stat(
    accessor: LinearAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    idx_key = "/" + key if key else "/"

    if key in VIRTUAL_DIRS:
        return FileStat(name=key if key else "/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if len(parts) == 2 and parts[0] == "teams":
        result = await index.get(idx_key)
        if result.entry is None:
            await _populate_via_parent(accessor, idx_key, prefix, index)
            result = await index.get(idx_key)
            if result.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            modified=result.entry.remote_time or None,
            extra={"team_id": result.entry.id},
        )

    if len(parts) == 3 and parts[0] == "teams" and parts[2] in {
            "team.json", "members", "issues", "projects", "cycles", "documents"
    }:
        if parts[2] == "team.json":
            team_key = "/" + "/".join(parts[:2])
            result = await index.get(team_key)
            if result.entry is None:
                await _populate_via_parent(accessor, team_key, prefix, index)
                result = await index.get(team_key)
                if result.entry is None:
                    raise enoent(virtual)
            return FileStat(
                name="team.json",
                type=FileType.JSON,
                size=result.entry.extra.get("team_json_size"),
                modified=result.entry.remote_time or None,
                extra={"team_id": result.entry.id},
            )
        return FileStat(name=parts[2], type=FileType.DIRECTORY)

    if len(parts) == 4 and parts[0] == "teams" and parts[2] == "members":
        result = await index.get(idx_key)
        if result.entry is None:
            await _populate_via_parent(accessor, idx_key, prefix, index)
            result = await index.get(idx_key)
            if result.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            size=result.entry.size,
            modified=result.entry.remote_time or None,
            extra={"user_id": result.entry.id},
        )

    if len(parts) == 4 and parts[0] == "teams" and parts[2] == "issues":
        result = await index.get(idx_key)
        if result.entry is None:
            await _populate_via_parent(accessor, idx_key, prefix, index)
            result = await index.get(idx_key)
            if result.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.DIRECTORY,
            modified=result.entry.remote_time or None,
            extra={"issue_id": result.entry.id},
        )

    if (len(parts) == 5 and parts[0] == "teams" and parts[2] == "issues"
            and parts[4] in {"issue.json", "comments.jsonl"}):
        result = await index.get(idx_key)
        if result.entry is None:
            await _populate_via_parent(accessor, idx_key, prefix, index)
            result = await index.get(idx_key)
            if result.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=parts[4],
            type=(FileType.JSON
                  if parts[4] == "issue.json" else FileType.TEXT),
            size=result.entry.size,
            modified=result.entry.remote_time or None,
            extra={"issue_id": result.entry.id},
        )

    if len(parts) == 4 and parts[0] == "teams" and parts[2] in {
            "projects", "cycles", "documents"
    }:
        result = await index.get(idx_key)
        if result.entry is None:
            await _populate_via_parent(accessor, idx_key, prefix, index)
            result = await index.get(idx_key)
            if result.entry is None:
                raise enoent(virtual)
        id_field = {
            "projects": "project_id",
            "cycles": "cycle_id",
            "documents": "document_id",
        }[parts[2]]
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            size=result.entry.size,
            modified=result.entry.remote_time or None,
            extra={id_field: result.entry.id},
        )

    raise enoent(virtual)

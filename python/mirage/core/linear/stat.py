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
from mirage.cache.index import IndexCacheStore
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
    index: IndexCacheStore,
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
    except Exception as exc:
        # best-effort cache populate; canonical ENOENT raised below
        logger.debug("stat populate failed for %s: %s", idx_key, exc)


async def stat(
    accessor: LinearAccessor,
    path: PathSpec,
    index: IndexCacheStore,
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
            "team.json", "members", "issues", "projects", "cycles"
    }:
        if parts[2] == "team.json":
            team_key = "/" + "/".join(parts[:2])
            if index is not None:
                result = await index.get(team_key)
                team_id = result.entry.id if result.entry else None
            else:
                team_id = None
            return FileStat(
                name="team.json",
                type=FileType.JSON,
                extra={"team_id": team_id},
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

    if len(parts) == 5 and parts[0] == "teams" and parts[2] == "issues":
        if parts[4] == "issue.json":
            issue_key = "/" + "/".join(parts[:4])
            if index is not None:
                result = await index.get(issue_key)
                issue_id = result.entry.id if result.entry else None
            else:
                issue_id = None
            return FileStat(
                name="issue.json",
                type=FileType.JSON,
                extra={"issue_id": issue_id},
            )
        if parts[4] == "comments.jsonl":
            issue_key = "/" + "/".join(parts[:4])
            if index is not None:
                result = await index.get(issue_key)
                issue_id = result.entry.id if result.entry else None
            else:
                issue_id = None
            return FileStat(
                name="comments.jsonl",
                type=FileType.TEXT,
                extra={"issue_id": issue_id},
            )

    if len(parts) == 4 and parts[0] == "teams" and parts[2] in {
            "projects", "cycles"
    }:
        result = await index.get(idx_key)
        if result.entry is None:
            await _populate_via_parent(accessor, idx_key, prefix, index)
            result = await index.get(idx_key)
            if result.entry is None:
                raise enoent(virtual)
        return FileStat(
            name=result.entry.vfs_name,
            type=FileType.JSON,
            modified=result.entry.remote_time or None,
            extra={
                "project_id" if parts[2] == "projects" else "cycle_id":
                result.entry.id
            },
        )

    raise enoent(virtual)

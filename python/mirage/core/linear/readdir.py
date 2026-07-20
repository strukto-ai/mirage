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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.linear._client import (list_team_cycles, list_team_documents,
                                        list_team_issues, list_team_members,
                                        list_team_projects, list_teams)
from mirage.core.linear.pathing import (cycle_filename, document_filename,
                                        issue_dirname, member_filename,
                                        project_filename, team_dirname)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

VIRTUAL_ROOTS = ("teams", )


async def readdir(
    accessor: LinearAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    idx_key = "/" + key if key else "/"

    if not key:
        return [f"{prefix}/teams"]

    if key == "teams":
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        teams = await list_teams(accessor.config)
        if accessor.config.team_ids:
            teams = [
                team for team in teams
                if team.get("id") in accessor.config.team_ids
            ]
        entries = []
        for team in teams:
            dirname = team_dirname(team)
            entry = IndexEntry(
                id=team["id"],
                name=team.get("name") or team.get("key") or team["id"],
                resource_type="linear/team",
                remote_time=team.get("updatedAt") or "",
                vfs_name=dirname,
            )
            entries.append((dirname, entry))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/teams/{name}" for name, _ in entries]

    parts = key.split("/")
    if len(parts) == 2 and parts[0] == "teams":
        result = await index.get(idx_key)
        if result.entry is None:
            # Auto-bootstrap: populate teams index.
            parent = PathSpec(
                virtual=prefix + "/teams",
                directory=prefix + "/teams",
                resource_path=mount_key(prefix + "/teams", prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(idx_key)
        if result.entry is None:
            raise enoent(virtual)
        return [
            f"{prefix}/{key}/team.json",
            f"{prefix}/{key}/members",
            f"{prefix}/{key}/issues",
            f"{prefix}/{key}/projects",
            f"{prefix}/{key}/cycles",
            f"{prefix}/{key}/documents",
        ]

    if len(parts) == 3 and parts[0] == "teams" and parts[2] == "members":
        team_vkey = "/" + "/".join(parts[:2])
        result = await index.get(team_vkey)
        if result.entry is None:
            # Auto-bootstrap: populate team index.
            parent = PathSpec(
                virtual=prefix + "/" + "/".join(parts[:2]),
                directory=prefix + "/" + "/".join(parts[:2]),
                resource_path=mount_key(prefix + "/" + "/".join(parts[:2]),
                                        prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(team_vkey)
        if result.entry is None:
            raise enoent(virtual)
        team_id = result.entry.id
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        users = await list_team_members(accessor.config, team_id)
        entries = []
        for user in users:
            filename = member_filename(user)
            entries.append((
                filename,
                IndexEntry(
                    id=user["id"],
                    name=user.get("name") or user.get("displayName")
                    or user["id"],
                    resource_type="linear/user",
                    remote_time=user.get("updatedAt") or "",
                    vfs_name=filename,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if len(parts) == 3 and parts[0] == "teams" and parts[2] == "issues":
        team_vkey = "/" + "/".join(parts[:2])
        result = await index.get(team_vkey)
        if result.entry is None:
            parent = PathSpec(
                virtual=prefix + "/" + "/".join(parts[:2]),
                directory=prefix + "/" + "/".join(parts[:2]),
                resource_path=mount_key(prefix + "/" + "/".join(parts[:2]),
                                        prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(team_vkey)
        if result.entry is None:
            raise enoent(virtual)
        team_id = result.entry.id
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        issues = await list_team_issues(accessor.config, team_id)
        entries = []
        for issue in issues:
            dirname = issue_dirname(issue)
            entries.append((
                dirname,
                IndexEntry(
                    id=issue["id"],
                    name=issue.get("identifier") or issue["id"],
                    resource_type="linear/issue",
                    remote_time=issue.get("updatedAt") or "",
                    vfs_name=dirname,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if len(parts) == 4 and parts[0] == "teams" and parts[2] == "issues":
        result = await index.get(idx_key)
        if result.entry is None:
            parent = PathSpec(
                virtual=prefix + "/" + "/".join(parts[:3]),
                directory=prefix + "/" + "/".join(parts[:3]),
                resource_path=mount_key(prefix + "/" + "/".join(parts[:3]),
                                        prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(idx_key)
        if result.entry is None:
            raise enoent(virtual)
        return [f"{prefix}/{key}/issue.json", f"{prefix}/{key}/comments.jsonl"]

    if len(parts) == 3 and parts[0] == "teams" and parts[2] == "projects":
        team_vkey = "/" + "/".join(parts[:2])
        result = await index.get(team_vkey)
        if result.entry is None:
            parent = PathSpec(
                virtual=prefix + "/" + "/".join(parts[:2]),
                directory=prefix + "/" + "/".join(parts[:2]),
                resource_path=mount_key(prefix + "/" + "/".join(parts[:2]),
                                        prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(team_vkey)
        if result.entry is None:
            raise enoent(virtual)
        team_id = result.entry.id
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        projects = await list_team_projects(accessor.config, team_id)
        entries = []
        for project in projects:
            filename = project_filename(project)
            entries.append((
                filename,
                IndexEntry(
                    id=project["id"],
                    name=project.get("name") or project["id"],
                    resource_type="linear/project",
                    remote_time=project.get("updatedAt") or "",
                    vfs_name=filename,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if len(parts) == 3 and parts[0] == "teams" and parts[2] == "cycles":
        team_vkey = "/" + "/".join(parts[:2])
        result = await index.get(team_vkey)
        if result.entry is None:
            parent = PathSpec(
                virtual=prefix + "/" + "/".join(parts[:2]),
                directory=prefix + "/" + "/".join(parts[:2]),
                resource_path=mount_key(prefix + "/" + "/".join(parts[:2]),
                                        prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(team_vkey)
        if result.entry is None:
            raise enoent(virtual)
        team_id = result.entry.id
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        cycles = await list_team_cycles(accessor.config, team_id)
        entries = []
        for cycle in cycles:
            filename = cycle_filename(cycle)
            entries.append((
                filename,
                IndexEntry(
                    id=cycle["id"],
                    name=cycle.get("name") or cycle["id"],
                    resource_type="linear/cycle",
                    remote_time=cycle.get("updatedAt") or "",
                    vfs_name=filename,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    if len(parts) == 3 and parts[0] == "teams" and parts[2] == "documents":
        team_vkey = "/" + "/".join(parts[:2])
        result = await index.get(team_vkey)
        if result.entry is None:
            parent = PathSpec(
                virtual=prefix + "/" + "/".join(parts[:2]),
                directory=prefix + "/" + "/".join(parts[:2]),
                resource_path=mount_key(prefix + "/" + "/".join(parts[:2]),
                                        prefix),
            )
            await readdir(accessor, parent, index)
            result = await index.get(team_vkey)
        if result.entry is None:
            raise enoent(virtual)
        team_id = result.entry.id
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        documents = await list_team_documents(accessor.config, team_id)
        entries = []
        for document in documents:
            filename = document_filename(document)
            entries.append((
                filename,
                IndexEntry(
                    id=document["id"],
                    name=document.get("title") or document["id"],
                    resource_type="linear/document",
                    remote_time=document.get("updatedAt") or "",
                    vfs_name=filename,
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    return []

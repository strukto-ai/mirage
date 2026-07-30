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
from mirage.core.linear._client import (get_issue, list_issue_comments,
                                        list_team_cycles, list_team_documents,
                                        list_team_issues, list_team_members,
                                        list_team_projects, list_teams)
from mirage.core.linear.normalize import (normalize_comment, normalize_cycle,
                                          normalize_document, normalize_issue,
                                          normalize_project, normalize_team,
                                          normalize_user, project_issue_rows,
                                          to_json_bytes, to_jsonl_bytes)
from mirage.core.linear.pathing import (cycle_filename, document_filename,
                                        issue_dirname, member_filename,
                                        project_filename, team_dirname)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

VIRTUAL_ROOTS = ("teams", )


async def _size_issue_files(
    accessor: LinearAccessor,
    idx_key: str,
    entry: IndexEntry,
    index: IndexCacheStore,
) -> None:
    """Store sized index entries for an issue directory's two files.

    issue.json is sized from the payload the issues listing already fetched
    (stored on the issue entry by the parent readdir); comments.jsonl costs
    the one bounded comments call, paid only when this directory is entered.
    """
    issue_id = entry.id
    issue_json_size = entry.extra.get("issue_json_size")
    issue_key = entry.extra.get("issue_key")
    if issue_json_size is None:
        issue = await get_issue(accessor.config, issue_id)
        normalized = normalize_issue(issue)
        issue_json_size = len(to_json_bytes(normalized))
        issue_key = normalized.get("issue_key")
    comments = await list_issue_comments(accessor.config, issue_id)
    rows = [
        normalize_comment(comment, issue_id=issue_id, issue_key=issue_key)
        for comment in comments
    ]
    comments_time = max((row.get("updated_at") or "" for row in rows),
                        default="")
    await index.set_dir(idx_key, [
        (
            "issue.json",
            IndexEntry(
                id=issue_id,
                name="issue.json",
                resource_type="linear/issue_json",
                remote_time=entry.remote_time,
                vfs_name="issue.json",
                size=issue_json_size,
            ),
        ),
        (
            "comments.jsonl",
            IndexEntry(
                id=issue_id,
                name="comments.jsonl",
                resource_type="linear/comments",
                remote_time=comments_time or entry.remote_time,
                vfs_name="comments.jsonl",
                size=len(to_jsonl_bytes(rows)),
            ),
        ),
    ])


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
                extra={
                    "team_key": team.get("key"),
                    "team_name": team.get("name"),
                    "team_json_size": len(to_json_bytes(normalize_team(team))),
                },
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
                    size=len(to_json_bytes(normalize_user(user))),
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
                    extra={
                        "issue_key":
                        issue.get("identifier"),
                        "issue_json_size":
                        len(to_json_bytes(normalize_issue(issue))),
                    },
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
        listing = await index.list_dir(idx_key)
        if listing.entries is None:
            await _size_issue_files(accessor, idx_key, result.entry, index)
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
        team_key = result.entry.extra.get("team_key")
        team_name = result.entry.extra.get("team_name")
        if "team_key" not in result.entry.extra:
            teams = await list_teams(accessor.config)
            team = next((item for item in teams if item.get("id") == team_id),
                        {})
            team_key = team.get("key")
            team_name = team.get("name")
        team_issues = await list_team_issues(accessor.config, team_id)
        entries = []
        for project in projects:
            rendered = normalize_project(
                project,
                team_id=team_id,
                team_key=team_key,
                team_name=team_name,
                issues=project_issue_rows(team_issues, project.get("id")),
            )
            filename = project_filename(project)
            entries.append((
                filename,
                IndexEntry(
                    id=project["id"],
                    name=project.get("name") or project["id"],
                    resource_type="linear/project",
                    remote_time=project.get("updatedAt") or "",
                    vfs_name=filename,
                    size=len(to_json_bytes(rendered)),
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
                    size=len(
                        to_json_bytes(normalize_cycle(cycle,
                                                      team_id=team_id))),
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
                    size=len(to_json_bytes(normalize_document(document))),
                ),
            ))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/{key}/{name}" for name, _ in entries]

    # An unrecognized path is not an empty directory: returning [] made `ls`
    # and `tree` report a bogus path as a real-but-empty one, and left `rg`
    # without a message.
    raise enoent(virtual)

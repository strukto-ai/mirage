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

from collections.abc import Sequence
from typing import Any

from mirage.accessor.linear import LinearAccessor
from mirage.core.linear.client import get_issue, list_teams
from mirage.core.linear.pathing import issue_dirname, team_dirname
from mirage.events.payload import event_at, field, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec

_PROJECT_ROW_FIELDS = frozenset(
    {"title", "stateId", "projectId", "archivedAt", "teamId"}
)

_ISSUE_FILES = ("issue.json", "comments.jsonl")


class LinearEventHook:
    """Map one Linear webhook delivery onto mount paths.

    The consumer owns the receiver and passes the delivery's ``type``
    (the ``Linear-Event`` header) with the JSON body. Nothing here runs
    a loop. ``Issue`` and ``Comment`` map; every other entity maps to
    nothing.

    An issue is the directory ``teams/<team>/issues/<KEY-N>__<id>`` with
    ``issue.json`` and ``comments.jsonl``, both named as ``readdir``
    names them. An issue body carries its team, so its path needs no
    call; a comment names only its issue, which is read once through
    ``issue(id)`` and remembered. A team the mount's ``team_ids`` leaves
    out maps to nothing.

    A new issue creates both files and a removed one deletes its
    directory. An archived issue leaves the listing as a removed one
    does, and one restored from the archive comes back as new. An issue
    moved to another team changes its key too, so its old place is
    gone: the old team's ``issues`` is UNKNOWN. A project file lists its
    team's issues with their keys, titles and states, so an issue that
    is or was in a project and is created, removed, archived, moved or
    changes one of those is UNKNOWN on its team's ``projects``. A
    comment created, edited or removed updates its issue's
    ``comments.jsonl``.
    """

    def __init__(self, accessor: LinearAccessor) -> None:
        """Args:
        accessor (LinearAccessor): Backend handle, read for its config
            and used to resolve teams and issues.
        """
        self._accessor = accessor
        self._teams: dict[str, dict[str, Any]] = {}
        self._issues: dict[str, str] = {}

    async def _team_dir(
        self, team_id: str | None, team: JsonValue
    ) -> str | None:
        """The directory of a team the mount shows, or None.

        Args:
            team_id (str | None): The team's id.
            team (JsonValue): The team object the body carries, if any.
        """
        if team_id is None:
            return None
        wanted = self._accessor.config.team_ids
        if wanted and team_id not in wanted:
            return None
        if isinstance(team, dict) and text_field(team, "key") is not None:
            self._teams[team_id] = dict(team)
        if team_id not in self._teams:
            for listed in await list_teams(self._accessor):
                self._teams[str(listed.get("id"))] = listed
        known = self._teams.get(team_id)
        return f"teams/{team_dirname(known)}" if known is not None else None

    async def _issue_dir(self, issue: JsonValue) -> str | None:
        """The directory an issue body places the issue at, remembered,
        or None, and forgotten, when the mount does not show its team.

        Args:
            issue (JsonValue): An issue as a delivery or ``issue(id)``
                carries it.
        """
        issue_id = text_field(issue, "id")
        team = field(issue, "team")
        team_id = text_field(issue, "teamId") or text_field(team, "id")
        team_dir = await self._team_dir(team_id, team)
        if issue_id is None:
            return None
        if team_dir is None or team_id is None:
            self._issues.pop(issue_id, None)
            return None
        key = text_field(issue, "identifier")
        number = field(issue, "number")
        prefix = text_field(self._teams.get(team_id), "key")
        if key is None and prefix is not None and isinstance(number, int):
            key = f"{prefix}-{number}"
        place = f"{team_dir}/issues/" + issue_dirname(
            {"id": issue_id, "identifier": key}
        )
        self._issues[issue_id] = place
        return place

    async def _issue(
        self, root: PathSpec, action: str | None, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map an issue created, updated or removed.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            action (str | None): The delivery's ``action``.
            payload (JsonValue): The delivery's body.
        """
        data = field(payload, "data")
        before = field(payload, "updatedFrom")
        changed = set(before) if isinstance(before, dict) else set()
        in_project = text_field(data, "projectId") is not None or (
            "projectId" in changed
        )
        listed = in_project and (
            action != "update" or bool(changed & _PROJECT_ROW_FIELDS)
        )
        events: list[FileEvent] = []
        teams: list[str] = []
        old_team = text_field(before, "teamId")
        old_dir = await self._team_dir(old_team, None)
        if old_dir is not None:
            teams.append(old_dir)
            events.append(
                event_at(root, f"{old_dir}/issues", FileChangeKind.UNKNOWN)
            )
        place = await self._issue_dir(data)
        if place is not None:
            teams.append(place.rsplit("/issues/", 1)[0])
            archived = field(data, "archivedAt") is not None
            if action == "remove" or (archived and "archivedAt" in changed):
                events.append(event_at(root, place, FileChangeKind.DELETE))
            elif (
                action == "create"
                or old_team is not None
                or field(before, "archivedAt") is not None
            ):
                events.extend(
                    event_at(root, f"{place}/{name}", FileChangeKind.CREATE)
                    for name in _ISSUE_FILES
                )
            elif not archived:
                events.append(
                    event_at(
                        root, f"{place}/issue.json", FileChangeKind.UPDATE
                    )
                )
        if listed:
            events.extend(
                event_at(root, f"{team}/projects", FileChangeKind.UNKNOWN)
                for team in teams
            )
        return tuple(events)

    async def _comment(
        self, root: PathSpec, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map a comment created, edited or removed onto its issue.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            payload (JsonValue): The delivery's body.
        """
        data = field(payload, "data")
        issue_id = text_field(data, "issueId") or text_field(
            field(data, "issue"), "id"
        )
        if issue_id is None:
            return ()
        place = self._issues.get(issue_id)
        if place is None:
            place = await self._issue_dir(
                await get_issue(self._accessor, issue_id)
            )
        if place is None:
            return ()
        return (
            event_at(root, f"{place}/comments.jsonl", FileChangeKind.UPDATE),
        )

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one webhook delivery to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The delivery's ``type``.
            payload (JsonValue): The delivery's JSON body.
        """
        if event_type == "Issue":
            return await self._issue(
                root, text_field(payload, "action"), payload
            )
        if event_type == "Comment":
            return await self._comment(root, payload)
        return ()

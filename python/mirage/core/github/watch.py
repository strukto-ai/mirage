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

from mirage.accessor.github import GitHubAccessor
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.watch.events import event_at, field, text_field

# The most commits GitHub lists in one push delivery; a push at the cap
# may have lost some, so its paths are not the whole change.
_COMMIT_CAP = 2048

# The lists each pushed commit carries, and the change each one is.
_ACTIONS = ("added", "removed", "modified")


class GitHubEventHook:
    """Map one GitHub ``push`` webhook delivery onto mount paths.

    The consumer owns the receiver (a repository webhook for ``push``)
    and passes the event name from the ``X-GitHub-Event`` header with
    the JSON body. Nothing here runs a loop. A mount reads one ref of
    one repository, so only a push to that ref maps to anything; a mount
    that named no ref follows the default branch the payload names.

    Each pushed commit lists the paths it added, removed and modified,
    so a path's change is its first and last action across the push: one
    added and then removed within the push never existed outside it and
    maps to nothing. A forced push, a branch created or deleted, and a
    push at GitHub's commit cap do not say what changed between the old
    head and the new one, so the whole mount is UNKNOWN. Each event
    evicts the root listing above it, so the next read fetches the new
    head's tree.
    """

    def __init__(self, accessor: GitHubAccessor) -> None:
        """Args:
        accessor (GitHubAccessor): Backend handle, read for its
            repository and ref.
        """
        self._accessor = accessor

    async def to_events(
        self, root: PathSpec, event_name: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one push delivery to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_name (str): The ``X-GitHub-Event`` header.
            payload (JsonValue): The delivery's JSON body.
        """
        if event_name != "push":
            return ()
        accessor = self._accessor
        repository = field(payload, "repository")
        name = text_field(repository, "full_name") or ""
        if name.lower() != f"{accessor.owner}/{accessor.repo}".lower():
            return ()
        ref = accessor.ref or text_field(repository, "default_branch")
        if text_field(payload, "ref") not in (
            f"refs/heads/{ref}",
            f"refs/tags/{ref}",
        ):
            return ()
        commits = field(payload, "commits")
        if (
            any(
                field(payload, flag) is True
                for flag in ("forced", "created", "deleted")
            )
            or not isinstance(commits, list)
            or len(commits) >= _COMMIT_CAP
        ):
            return (event_at(root, "", FileChangeKind.UNKNOWN),)
        first: dict[str, str] = {}
        last: dict[str, str] = {}
        for commit in commits:
            for action in _ACTIONS:
                paths = field(commit, action)
                for path in paths if isinstance(paths, list) else ():
                    if isinstance(path, str):
                        first.setdefault(path, action)
                        last[path] = action
        events: list[FileEvent] = []
        for path, action in first.items():
            if action == "added" and last[path] == "removed":
                continue
            kind = (
                FileChangeKind.CREATE
                if action == "added"
                else FileChangeKind.DELETE
                if last[path] == "removed"
                else FileChangeKind.UPDATE
            )
            events.append(event_at(root, path, kind))
        return tuple(events)

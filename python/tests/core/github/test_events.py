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

import pytest

from mirage.accessor.github import GitHubAccessor, GitHubAccount
from mirage.core.github.config import GhConfig
from mirage.core.github.events import GitHubEventHook
from mirage.types import FileChangeKind, JsonValue, PathSpec

ACCOUNT = GitHubAccount(GhConfig(token="t"))
ROOT = PathSpec(virtual="/gh", directory="/gh", vfs_path="")


def _accessor(ref: str | None = "main") -> GitHubAccessor:
    return GitHubAccessor(
        account=ACCOUNT,
        owner="acme",
        repo="proj",
        ref=ref,
        default_branch="main",
        tree={},
    )


def _push(ref: str = "refs/heads/main", **extra: bool) -> dict[str, JsonValue]:
    return {
        "ref": ref,
        "repository": {"full_name": "Acme/Proj", "default_branch": "main"},
        "commits": [
            {
                "added": ["new.txt", "tmp.txt"],
                "removed": [],
                "modified": ["a.md"],
            },
            {
                "added": [],
                "removed": ["tmp.txt", "old.txt"],
                "modified": ["new.txt"],
            },
        ],
        **extra,
    }


def _pairs(events) -> list[tuple[FileChangeKind, str]]:
    return [(event.kind, event.path.virtual) for event in events]


@pytest.mark.asyncio
async def test_a_push_to_the_mounted_ref_names_each_path_once():
    # A path's change is its first and last action across the push; one
    # added and removed within it maps to nothing.
    events = await GitHubEventHook(_accessor()).to_events(
        ROOT, "push", _push()
    )
    assert _pairs(events) == [
        (FileChangeKind.CREATE, "/gh/new.txt"),
        (FileChangeKind.UPDATE, "/gh/a.md"),
        (FileChangeKind.DELETE, "/gh/old.txt"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event, payload, ref, expected",
    [
        ("push", _push("refs/heads/dev"), "main", []),
        ("issues", _push(), "main", []),
        (
            "push",
            {**_push(), "repository": {"full_name": "acme/other"}},
            "main",
            [],
        ),
        (
            "push",
            _push(forced=True),
            "main",
            [(FileChangeKind.UNKNOWN, "/gh")],
        ),
        (
            "push",
            _push(deleted=True),
            "main",
            [(FileChangeKind.UNKNOWN, "/gh")],
        ),
        ("push", _push(), None, None),
    ],
)
async def test_a_push_elsewhere_or_rewritten_is_skipped_or_unknown(
    event, payload, ref, expected
):
    # Another ref, event or repository maps nothing; a forced push or a
    # branch deleted cannot be described by its commits. A mount with no
    # ref follows the default branch the payload names.
    events = await GitHubEventHook(_accessor(ref)).to_events(
        ROOT, event, payload
    )
    if expected is None:
        assert len(events) == 3
    else:
        assert _pairs(events) == expected

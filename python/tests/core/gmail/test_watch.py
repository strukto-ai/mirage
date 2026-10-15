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

from unittest.mock import MagicMock

import aiohttp
import pytest

from mirage.core.gmail import watch
from mirage.types import FileChangeKind, PathSpec
from tests.core.gmail.conftest import LABELS, MESSAGES, _message

pytestmark = pytest.mark.asyncio

ROOT = PathSpec.from_str_path("/gmail", vfs_path="")
TRASHED = {**MESSAGES[0], "labelIds": ["TRASH"]}
NEW = _message(
    "n3", ["INBOX"], "2026-01-07", "Cy <cy@example.com>", "Hi", "hey"
)


def _gone() -> aiohttp.ClientResponseError:
    return aiohttp.ClientResponseError(None, (), status=404)  # type: ignore[arg-type]


class Mailbox:
    """Gmail's history and messages, scripted per pull."""

    def __init__(self) -> None:
        self.history: dict[str, object] = {}
        self.now = "100"
        self.messages = {m["id"]: m for m in (TRASHED, NEW)}

    async def current_history_id(self, token_manager):
        return self.now

    async def list_history(self, token_manager, start):
        answer = self.history[start]
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def list_labels(self, token_manager):
        return LABELS

    async def get_message_raw(self, token_manager, message_id):
        return self.messages[message_id]


@pytest.fixture
def mailbox(monkeypatch):
    box = Mailbox()
    for name in (
        "current_history_id",
        "list_history",
        "list_labels",
        "get_message_raw",
    ):
        monkeypatch.setattr(watch, name, getattr(box, name))
    return box


def _pairs(delta):
    return [(c.kind, c.path.virtual) for c in delta.changes]


async def test_a_watch_follows_each_message_s_labels(mailbox):
    hook = watch.build_delta_hook(MagicMock())
    baseline = await hook.pull(ROOT, None)
    assert baseline.changes == ()
    mailbox.history["100"] = (
        [
            {
                "labelsAdded": [
                    {"message": {"id": "a1"}, "labelIds": ["TRASH"]}
                ]
            },
            {
                "labelsRemoved": [
                    {"message": {"id": "a1"}, "labelIds": ["INBOX"]}
                ]
            },
            {"messagesAdded": [{"message": {"id": "n3"}}]},
            {"messagesDeleted": [{"message": {"id": "z9"}}]},
        ],
        "120",
    )
    moved = await hook.pull(ROOT, baseline.checkpoint)
    old, new = "/gmail/INBOX/2026-01-05", "/gmail/TRASH/2026-01-05"
    assert _pairs(moved) == [
        (FileChangeKind.DELETE, f"{old}/Budget_review__a1.gmail.json"),
        (FileChangeKind.DELETE, f"{old}/Budget_review__a1"),
        (FileChangeKind.CREATE, f"{new}/Budget_review__a1.gmail.json"),
        (FileChangeKind.CREATE, f"{new}/Budget_review__a1"),
        (FileChangeKind.CREATE, "/gmail/INBOX/2026-01-07/Hi__n3.gmail.json"),
        (FileChangeKind.UNKNOWN, "/gmail"),
    ]
    # A message a pull has seen leaves the paths it was when it goes.
    mailbox.history["120"] = (
        [{"messagesDeleted": [{"message": {"id": "a1"}}]}],
        "130",
    )
    deleted = await hook.pull(ROOT, moved.checkpoint)
    assert _pairs(deleted) == [
        (FileChangeKind.DELETE, f"{new}/Budget_review__a1.gmail.json"),
        (FileChangeKind.DELETE, f"{new}/Budget_review__a1"),
    ]
    # A history id Gmail no longer keeps reinventories the root.
    mailbox.history["130"] = _gone()
    mailbox.now = "200"
    lost = await hook.pull(ROOT, deleted.checkpoint)
    assert _pairs(lost) == [(FileChangeKind.UNKNOWN, "/gmail")]
    assert '"history": "200"' in (lost.checkpoint or "")

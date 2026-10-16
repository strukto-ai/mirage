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

import asyncio

from mirage.core.email.watch import EmailEventHook
from mirage.types import FileChangeKind, PathSpec


def _root() -> PathSpec:
    return PathSpec(virtual="/mail", directory="/mail", vfs_path="")


def _map(event_type, payload) -> list[tuple[FileChangeKind, str]]:
    events = asyncio.run(
        EmailEventHook().to_events(_root(), event_type, payload)
    )
    return [(e.kind, e.path.virtual) for e in events]


def test_each_mailbox_change_is_unknown_on_its_folder():
    for name in ("EXISTS", "EXPUNGE", "FETCH", "VANISHED", "exists"):
        assert _map(name, {"mailbox": "INBOX"}) == [
            (FileChangeKind.UNKNOWN, "/mail/INBOX")
        ]


def test_the_folder_keeps_the_servers_spelling():
    assert _map("EXISTS", {"mailbox": "Archive/2026"}) == [
        (FileChangeKind.UNKNOWN, "/mail/Archive/2026")
    ]


def test_recent_and_a_missing_mailbox_map_to_nothing():
    assert _map("RECENT", {"mailbox": "INBOX"}) == []
    assert _map("EXISTS", {}) == []
    assert _map("EXISTS", "INBOX") == []

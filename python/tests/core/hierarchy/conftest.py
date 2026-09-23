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

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.codec import DATE, INT_JSON, JSON_NAME, Codec
from mirage.core.hierarchy.scope import (Scope, ScopeMatch, Slot,
                                         make_detect_scope)
from mirage.types import ContentType, PathSpec

SCOPES = (
    Scope(kind="rooms", segments=("rooms", ), probed=False),
    Scope(kind="room", segments=("rooms", Slot("room"))),
    Scope(kind="note",
          segments=("rooms", Slot("room"), Slot("note", JSON_NAME)),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="room_atts", segments=("rooms", Slot("room"), "atts")),
    Scope(kind="room_day", segments=("rooms", Slot("room"), Slot("day",
                                                                 DATE))),
    Scope(kind="revision",
          segments=("rooms", Slot("room"), "revisions", Slot("rev", INT_JSON)),
          leaf=True,
          filetype=ContentType.JSON),
    Scope(kind="tagged",
          segments=("tags", Slot("tag", Codec(validate=str.islower))),
          leaf=True,
          filetype=ContentType.TEXT),
)

detect_scope = make_detect_scope(SCOPES)

TREE: dict[str, list[str]] = {
    "rooms": ["red", "blue"],
    "red": ["a.json", "b.json"],
    "blue": [],
}


class FakeAccessor(Accessor):

    def __init__(self) -> None:
        self.calls: list[str] = []


def spec(mount_path: str) -> PathSpec:
    key = mount_path.strip("/")
    return PathSpec(virtual="/h" + mount_path if key else "/h",
                    directory="/h/",
                    vfs_path=key)


async def list_rooms(accessor: FakeAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    accessor.calls.append("rooms")
    return [(room,
             IndexEntry(id=room,
                        name=room,
                        resource_type="fake/room",
                        vfs_name=room)) for room in TREE["rooms"]]


async def list_notes(accessor: FakeAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    accessor.calls.append(f"notes:{match.slots['room']}")
    return [(note,
             IndexEntry(id=note,
                        name=note,
                        resource_type="fake/note",
                        vfs_name=note,
                        size=7)) for note in TREE[match.slots["room"]]]


async def room_guard(accessor: FakeAccessor, match: ScopeMatch,
                     virtual: str) -> None:
    accessor.calls.append(f"guard:{match.slots['room']}")
    if match.slots["room"] not in TREE["rooms"]:
        raise FileNotFoundError(virtual)


@pytest.fixture
def accessor() -> FakeAccessor:
    return FakeAccessor()

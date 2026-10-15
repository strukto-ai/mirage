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

import pytest

from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.types import ContentType, DirListing, FileStat, FileType, PathSpec
from tests.core.hierarchy.conftest import (
    FakeAccessor,
    detect_scope,
    list_notes,
    list_rooms,
    room_guard,
    spec,
)

READDIR = make_readdir(
    detect_scope,
    listers={
        "rooms": list_rooms,
        "room": list_notes,
    },
    static_root=("rooms",),
    guards={"room": room_guard},
)


def names(listed: list[FileStat] | DirListing) -> list[str]:
    rows = listed.entries if isinstance(listed, DirListing) else listed
    return [row.name for row in rows]


def test_static_root_lists_without_any_call(accessor):
    rows = asyncio.run(READDIR(accessor, spec("/")))
    assert rows == [FileStat(name="rooms", type=FileType.DIRECTORY)]
    assert accessor.calls == []


def test_a_lister_answers_its_children_as_stat_does(accessor):
    assert names(asyncio.run(READDIR(accessor, spec("/rooms")))) == [
        "red",
        "blue",
    ]


def test_a_listed_leaf_renders_as_its_scope_filetype(accessor):
    # The lister left the note untyped; its scope says JSON, which is
    # what stat answered for it.
    rows = asyncio.run(READDIR(accessor, spec("/rooms/red")))
    assert [(r.name, r.content, r.size) for r in rows] == [
        ("a.json", ContentType.JSON, 7),
        ("b.json", ContentType.JSON, 7),
    ]


def test_extras_ride_each_listed_row(accessor):
    readdir = make_readdir(
        detect_scope,
        listers={"rooms": list_rooms},
        static_root=("rooms",),
        extras={"room": lambda match: {"room": match.slots["room"]}},
    )
    rows = asyncio.run(readdir(accessor, spec("/rooms")))
    assert [row.extra for row in rows] == [
        {"room_id": "red", "room": "red"},
        {"room_id": "blue", "room": "blue"},
    ]


def test_guard_runs_before_the_lister(accessor):
    asyncio.run(READDIR(accessor, spec("/rooms/red")))
    assert accessor.calls == ["guard:red", "notes:red"]


def test_guard_failure_is_enoent_even_for_a_listable_shape(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(READDIR(accessor, spec("/rooms/ghost")))


def test_leaf_and_invalid_paths_refuse(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(READDIR(accessor, spec("/rooms/red/a.json")))
    with pytest.raises(FileNotFoundError):
        asyncio.run(READDIR(accessor, spec("/halls")))


def test_dot_prefixed_names_are_dropped_from_listings(accessor):
    # The classifier refuses every dot-leading segment, so a listing
    # must not advertise one (a quoted postgres schema can be named
    # ".foo"; every other op would report it absent).
    async def hidden_rooms(a, match):
        rooms = await list_rooms(a, match)
        return [rooms[0].model_copy(update={"name": ".secret"}), *rooms]

    readdir = make_readdir(
        detect_scope, listers={"rooms": hidden_rooms}, static_root=("rooms",)
    )
    assert names(asyncio.run(readdir(accessor, spec("/rooms")))) == [
        "red",
        "blue",
    ]


def test_leaf_error_can_be_enotdir(accessor):
    readdir = make_readdir(
        detect_scope,
        listers={"rooms": list_rooms},
        static_root=("rooms",),
        leaf_error="enotdir",
    )
    with pytest.raises(NotADirectoryError):
        asyncio.run(readdir(accessor, spec("/rooms/red/a.json")))


async def _entry_notes(
    accessor: FakeAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    accessor.calls.append(f"entry-notes:{entry.extra['room_id']}")
    return [
        FileStat(
            name="note.json",
            type=FileType.FILE,
            size=entry.extra.get("json_size"),
        )
    ]


ENTRY_READDIR = make_readdir(
    detect_scope,
    listers={"rooms": list_rooms},
    entry_listers={"room": _entry_notes},
    static_root=("rooms",),
)


def test_an_entry_lister_is_handed_the_directorys_row(accessor):
    row = FileStat(
        name="red",
        type=FileType.DIRECTORY,
        extra={"room_id": "red", "json_size": 11},
    )
    rows = asyncio.run(ENTRY_READDIR(accessor, spec("/rooms/red"), row))
    assert [(r.name, r.size) for r in rows] == [("note.json", 11)]
    assert accessor.calls == ["entry-notes:red"]


def test_an_entry_lister_with_no_row_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(ENTRY_READDIR(accessor, spec("/rooms/ghost")))
    assert accessor.calls == []


def test_a_kind_in_both_lister_tables_fails_at_build():
    with pytest.raises(ValueError):
        make_readdir(
            detect_scope,
            listers={"room": list_notes},
            entry_listers={"room": _entry_notes},
        )


async def _day_lister(
    accessor: FakeAccessor, match: ScopeMatch, parent: FileStat
) -> list[FileStat]:
    accessor.calls.append(
        f"day:{parent.extra['room_id']}:{match.slots['day']}"
    )
    return [FileStat(name="atts", type=FileType.DIRECTORY)]


PARENT_READDIR = make_readdir(
    detect_scope,
    listers={"rooms": list_rooms},
    parent_entry_listers={"room_day": _day_lister},
    static_root=("rooms",),
)


def test_a_parent_entry_lister_is_proven_by_the_parents_row(accessor):
    room = FileStat(
        name="red", type=FileType.DIRECTORY, extra={"room_id": "r"}
    )
    rows = asyncio.run(
        PARENT_READDIR(accessor, spec("/rooms/red/2026-01-05"), None, room)
    )
    assert names(rows) == ["atts"]
    assert accessor.calls == ["day:r:2026-01-05"]


def test_a_parent_entry_lister_with_no_parent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(PARENT_READDIR(accessor, spec("/rooms/ghost/2026-01-05")))


def test_a_kind_in_several_lister_tables_fails_at_build():
    with pytest.raises(ValueError):
        make_readdir(
            detect_scope,
            listers={"rooms": list_rooms},
            entry_listers={"room_day": _day_lister},
            parent_entry_listers={"room_day": _day_lister},
        )


async def _seeding_rooms(
    accessor: FakeAccessor, match: ScopeMatch
) -> DirListing:
    accessor.calls.append("rooms")
    return DirListing(
        [FileStat(name="red", type=FileType.DIRECTORY)],
        seeds={
            "red": [
                FileStat(name="a.json", type=FileType.FILE),
                FileStat(name=".hidden.json", type=FileType.FILE),
            ]
        },
        window=True,
    )


def test_seeds_are_finished_like_the_listing(accessor):
    readdir = make_readdir(
        detect_scope, listers={"rooms": _seeding_rooms}, static_root=("rooms",)
    )
    listed = asyncio.run(readdir(accessor, spec("/rooms")))
    assert isinstance(listed, DirListing)
    assert listed.window
    assert names(listed) == ["red"]
    assert [(r.name, r.content) for r in listed.seeds["red"]] == [
        ("a.json", ContentType.JSON)
    ]


def _globbed(mount_path: str, pattern: str) -> PathSpec:
    base = spec(mount_path)
    return PathSpec(
        virtual=base.virtual + "/" + pattern,
        directory=base.virtual + "/",
        vfs_path=base.vfs_path + "/" + pattern,
        pattern=pattern,
    )


def test_a_pattern_kind_hands_the_glob_to_its_lister(accessor):
    async def days(a, match):
        a.calls.append(f"days:{match.pattern}")
        return DirListing(
            [FileStat(name="2026-01-05", type=FileType.DIRECTORY)], window=True
        )

    readdir = make_readdir(
        detect_scope,
        listers={"room": days},
        pattern_kinds={"room": lambda pattern: pattern.startswith("2026")},
    )
    asyncio.run(readdir(accessor, _globbed("/rooms/red", "2026-*")))
    asyncio.run(readdir(accessor, _globbed("/rooms/red", "*.json")))
    assert accessor.calls == ["days:2026-*", "days:None"]

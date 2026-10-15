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

from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat, make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from tests.core.hierarchy.conftest import (
    FakeAccessor,
    detect_scope,
    room_guard,
    spec,
)


def _room_extra(match: ScopeMatch) -> dict[str, str]:
    return {"room": match.slots["room"]}


STAT = make_stat(
    detect_scope,
    guards={"room": room_guard},
    extras={"room": _room_extra},
)


def test_root_and_static_dirs_answer_without_probing(accessor):
    assert asyncio.run(STAT(accessor, spec("/"))).name == "/"
    st = asyncio.run(STAT(accessor, spec("/rooms")))
    assert st.type == FileType.DIRECTORY
    assert st.name == "rooms"
    assert accessor.calls == []


def test_a_listed_row_answers_without_its_guard(accessor):
    row = FileStat(name="red", type=FileType.DIRECTORY, extra={"room": "red"})
    assert asyncio.run(STAT(accessor, spec("/rooms/red"), row)) is row
    assert accessor.calls == []


def test_a_guarded_dir_no_listing_names_carries_extras(accessor):
    st = asyncio.run(STAT(accessor, spec("/rooms/red")))
    assert st.type == FileType.DIRECTORY
    assert st.extra == {"room": "red"}
    assert accessor.calls == ["guard:red"]


def test_a_probed_leaf_no_listing_names_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(STAT(accessor, spec("/rooms/red/nope.json")))


def test_invalid_shapes_are_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        asyncio.run(STAT(accessor, spec("/halls")))
    with pytest.raises(FileNotFoundError):
        asyncio.run(STAT(accessor, spec("/rooms/.red")))


def test_an_override_replaces_the_whole_answer(accessor):
    async def bespoke(
        accessor: FakeAccessor,
        match: ScopeMatch,
        path: PathSpec,
        entry: FileStat | None,
        parent: FileStat | None,
    ) -> FileStat:
        return FileStat(
            name="custom",
            type=FileType.FILE,
            content=ContentType.TEXT,
            size=None if parent is None else 1,
        )

    stat = make_stat(detect_scope, overrides={"note": bespoke})
    room = FileStat(name="red", type=FileType.DIRECTORY)
    st = asyncio.run(stat(accessor, spec("/rooms/red/a.json"), None, room))
    assert (st.name, st.size) == ("custom", 1)
    assert accessor.calls == []


@pytest.mark.parametrize(
    "filetype, kind, content",
    [
        (FileType.DIRECTORY, FileType.DIRECTORY, None),
        (ContentType.JSON, FileType.FILE, ContentType.JSON),
        (None, FileType.FILE, ContentType.TEXT),
    ],
)
def test_entry_stat_builds_the_row_a_listing_names(filetype, kind, content):
    build = entry_stat("doc_id", filetype)
    row = build("a.txt", "D1", size=7, modified="", extra={"kept": 1})
    assert (row.name, row.type, row.content, row.size) == (
        "a.txt",
        kind,
        content,
        7,
    )
    assert row.modified is None
    assert row.extra == {"kept": 1, "doc_id": "D1"}

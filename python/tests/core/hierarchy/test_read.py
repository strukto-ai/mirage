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

from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import make_read, make_read_range
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import PathSpec
from tests.core.hierarchy.conftest import (
    FakeAccessor,
    detect_scope,
    list_notes,
    list_rooms,
    spec,
)


async def _read_note(
    accessor: FakeAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    return f"{match.slots['room']}:{match.slots['note']}".encode()


async def _read_note_window(
    accessor: FakeAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
    limit: int | None,
    offset: int | None,
) -> bytes:
    return f"{match.slots['note']}:{limit}:{offset}".encode()


READ = make_read(detect_scope, {"note": _read_note})


def test_reader_gets_the_slots(accessor):
    out = asyncio.run(READ(accessor, spec("/rooms/red/a.json")))
    assert out == b"red:a"


def test_directories_that_exist_by_construction_read_as_eisdir(accessor):
    # The root and a probed=False scope provably exist, so reading one
    # as a file is EISDIR rather than absent.
    for path in ("/", "/rooms"):
        with pytest.raises(IsADirectoryError):
            asyncio.run(READ(accessor, spec(path)))


def test_everything_else_is_enoent(accessor):
    # A probed directory shape is no proof the node exists, so a read
    # there reports absence, matching GNU's wording for a missing name.
    for path in ("/rooms/red", "/rooms/.red/a.json", "/halls"):
        with pytest.raises(FileNotFoundError):
            asyncio.run(READ(accessor, spec(path)))


def test_windowed_reader_receives_the_window(accessor):
    read = make_read(detect_scope, {}, windowed={"note": _read_note_window})
    out = asyncio.run(
        read(accessor, spec("/rooms/red/a.json"), limit=5, offset=2)
    )
    assert out == b"a:5:2"
    out = asyncio.run(read(accessor, spec("/rooms/red/a.json")))
    assert out == b"a:None:None"


def test_plain_reader_ignores_the_window(accessor):
    out = asyncio.run(READ(accessor, spec("/rooms/red/a.json"), limit=3))
    assert out == b"red:a"


async def _read_note_range(
    accessor: FakeAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
    offset: int,
    size: int | None,
) -> bytes:
    return f"ranged:{match.slots['note']}:{offset}:{size}".encode()


READ_RANGE = make_read_range(
    detect_scope, READ, ranged={"tagged": _read_note_range}
)


def test_ranged_reader_pushes_the_window_to_the_source(accessor):
    # "tagged" names a ranged reader, so the window reaches it verbatim.
    ranged = make_read_range(
        detect_scope, READ, ranged={"note": _read_note_range}
    )
    out = asyncio.run(
        ranged(accessor, spec("/rooms/red/a.json"), offset=2, size=5)
    )
    assert out == b"ranged:a:2:5"


def test_unranged_kind_slices_the_full_read(accessor):
    out = asyncio.run(
        READ_RANGE(accessor, spec("/rooms/red/a.json"), offset=1, size=3)
    )
    # The full read rendered "red:a"; the window is taken after the fact.
    assert out == b"ed:"


def test_ranged_read_defaults_to_the_whole_file(accessor):
    out = asyncio.run(READ_RANGE(accessor, spec("/rooms/red/a.json")))
    assert out == b"red:a"


PROVEN_STAT = make_stat(
    detect_scope,
    make_readdir(
        detect_scope, listers={"rooms": list_rooms, "room": list_notes}
    ),
)
PROVEN_READ = make_read(detect_scope, {"note": _read_note}, stat=PROVEN_STAT)


def test_a_read_proves_its_parent_through_stat(accessor):
    # "green" is not a room the listing names: the read is ENOENT for the
    # file itself, and its reader never runs.
    with pytest.raises(FileNotFoundError) as caught:
        asyncio.run(PROVEN_READ(accessor, spec("/rooms/green/a.json")))
    assert caught.value.filename == "/h/rooms/green/a.json"
    assert accessor.calls == ["rooms"]
    out = asyncio.run(PROVEN_READ(accessor, spec("/rooms/red/z.json")))
    # The parent is proven; the file stays the reader's to prove.
    assert out == b"red:z"


def test_a_read_without_stat_trusts_the_path(accessor):
    out = asyncio.run(READ(accessor, spec("/rooms/green/a.json")))
    assert out == b"green:a"
    assert accessor.calls == []

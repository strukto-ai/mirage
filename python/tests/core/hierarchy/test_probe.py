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

from mirage.core.hierarchy.probe import parent_spec, rows_under
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.types import FileStat, FileType
from tests.core.hierarchy.conftest import (
    FakeAccessor,
    detect_scope,
    list_notes,
    list_rooms,
    spec,
)


async def _notes_of(
    accessor: FakeAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    return await list_notes(accessor, match)


READDIR = make_readdir(
    detect_scope,
    listers={"rooms": list_rooms},
    entry_listers={"room": _notes_of},
    static_root=("rooms",),
)


def test_parent_spec_is_the_directory_holding_the_path():
    parent = parent_spec(spec("/rooms/red/a.json"))
    assert (parent.virtual, parent.vfs_path) == ("/h/rooms/red", "rooms/red")


def test_rows_under_walks_every_level_handing_each_its_row(accessor):
    walked = asyncio.run(rows_under(READDIR, accessor, spec("/"), None))
    assert [(path.virtual, row.type) for path, row in walked] == [
        ("/h/rooms", FileType.DIRECTORY),
        ("/h/rooms/red", FileType.DIRECTORY),
        ("/h/rooms/blue", FileType.DIRECTORY),
        ("/h/rooms/red/a.json", FileType.FILE),
        ("/h/rooms/red/b.json", FileType.FILE),
    ]
    assert accessor.calls == ["rooms", "notes:blue", "notes:red"]

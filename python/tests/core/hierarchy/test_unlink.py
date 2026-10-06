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
from unittest.mock import AsyncMock

import pytest

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.unlink import make_unlink
from mirage.errors.fs import enoent
from tests.core.hierarchy.conftest import (
    FakeAccessor,
    detect_scope,
    list_notes,
    list_rooms,
    spec,
)

READDIR = make_readdir(
    detect_scope,
    listers={
        "rooms": list_rooms,
        "room": list_notes,
    },
    static_root=("rooms",),
)


async def _delete(
    accessor: FakeAccessor, match: ScopeMatch, entry: IndexEntry
) -> None:
    accessor.calls.append(f"delete:{entry.id}")


UNLINK = make_unlink(detect_scope, READDIR, deleters={"note": _delete})


async def readdir_absent(_accessor, path, index=None):
    """Stand in for a readdir whose directory does not exist.

    Args:
        path (PathSpec): the parent directory being listed.
    """
    raise enoent(path.virtual)


def test_unlink_resolves_and_deletes_the_entry(accessor):
    index = RAMIndexCacheStore()
    asyncio.run(UNLINK(accessor, spec("/rooms/red/a.json"), index))
    assert accessor.calls == ["notes:red", "delete:a.json"]
    # The parent listing is invalidated so the gone entry cannot linger.
    listing = asyncio.run(index.list_dir("/h/rooms/red"))
    assert listing.entries is None or listing.entries == []


def test_unlink_refuses_a_directory(accessor):
    with pytest.raises(IsADirectoryError):
        asyncio.run(UNLINK(accessor, spec("/rooms/red")))
    with pytest.raises(IsADirectoryError):
        asyncio.run(UNLINK(accessor, spec("/")))


def test_unlink_missing_or_invalid_is_enoent(accessor):
    index = RAMIndexCacheStore()
    with pytest.raises(FileNotFoundError):
        asyncio.run(UNLINK(accessor, spec("/rooms/red/nope.json"), index))
    with pytest.raises(FileNotFoundError):
        asyncio.run(UNLINK(accessor, spec("/halls/x.json"), index))
    assert "delete:nope.json" not in accessor.calls


def test_unlink_propagates_parent_refresh_failure(accessor):
    readdir = AsyncMock(side_effect=RuntimeError("backend unavailable"))
    unlink = make_unlink(detect_scope, readdir, deleters={"note": _delete})
    with pytest.raises(RuntimeError, match="backend unavailable"):
        asyncio.run(
            unlink(accessor, spec("/rooms/red/a.json"), RAMIndexCacheStore())
        )


def test_unlink_names_the_operand_when_the_parent_is_absent(accessor):
    unlink = make_unlink(
        detect_scope, readdir_absent, deleters={"note": _delete}
    )
    path = spec("/rooms/red/a.json")
    with pytest.raises(FileNotFoundError) as excinfo:
        asyncio.run(unlink(accessor, path, RAMIndexCacheStore()))
    assert excinfo.value.filename == path.virtual

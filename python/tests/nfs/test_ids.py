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
import errno

import pytest

from mirage.nfs.errors import StaleHandleError
from mirage.nfs.ids import IdTable


def _table_with(*paths: str) -> tuple[IdTable, list[int]]:
    table = IdTable()
    return table, [table.alloc(p) for p in paths]


def test_alloc_is_stable_for_a_known_path():
    table = IdTable()
    assert table.alloc("/a.txt") == table.alloc("/a.txt")


def test_alloc_is_distinct_per_path():
    table, ids = _table_with("/a.txt", "/b.txt")
    assert len(set(ids)) == 2


def test_root_is_an_ordinary_allocation():
    table = IdTable()
    root = table.alloc("/")
    assert root > 0
    assert table.resolve(root) == "/"


def test_resolve_raises_stale_for_an_unknown_id():
    table = IdTable()
    try:
        table.resolve(9999)
    except StaleHandleError:
        return
    raise AssertionError("expected StaleHandleError")


def test_an_invalidated_id_is_never_reissued():
    table = IdTable()
    first = table.alloc("/gone.txt")
    table.invalidate(first)
    assert table.alloc("/gone.txt") != first


def test_invalidate_is_idempotent():
    table = IdTable()
    fileid = table.alloc("/a.txt")
    table.invalidate(fileid)
    table.invalidate(fileid)


def test_rename_moves_the_exact_path():
    table = IdTable()
    fileid = table.alloc("/old.txt")
    table.rename("/old.txt", "/new.txt")
    assert table.resolve(fileid) == "/new.txt"
    assert table.alloc("/new.txt") == fileid


def test_rename_rewrites_every_descendant():
    table = IdTable()
    child = table.alloc("/dir/child.txt")
    deep = table.alloc("/dir/sub/deep.txt")
    table.alloc("/dir")
    table.rename("/dir", "/moved")
    assert table.resolve(child) == "/moved/child.txt"
    assert table.resolve(deep) == "/moved/sub/deep.txt"


def test_rename_leaves_a_sibling_prefix_alone():
    table = IdTable()
    sibling = table.alloc("/directory.txt")
    table.alloc("/dir")
    table.rename("/dir", "/moved")
    assert table.resolve(sibling) == "/directory.txt"


def test_rename_into_own_subtree_is_einval():
    table = IdTable()
    fileid = table.alloc("/dir")
    with pytest.raises(OSError) as exc:
        table.rename("/dir", "/dir/inner")
    assert exc.value.errno == errno.EINVAL
    assert table.resolve(fileid) == "/dir"


def test_guard_rename_refuses_before_any_mutation():
    table = IdTable()
    table.alloc("/dir")
    with pytest.raises(OSError) as exc:
        table.guard_rename("/dir", "/dir/inner")
    assert exc.value.errno == errno.EINVAL
    table.guard_rename("/dir", "/elsewhere")


def test_rename_onto_an_existing_path_reassigns_it():
    table = IdTable()
    victim = table.alloc("/dst.txt")
    moved = table.alloc("/src.txt")
    table.rename("/src.txt", "/dst.txt")
    assert table.resolve(moved) == "/dst.txt"
    assert table.alloc("/dst.txt") == moved
    try:
        table.resolve(victim)
    except StaleHandleError:
        return
    raise AssertionError("the overwritten id should be stale")


def test_rename_of_an_untracked_path_still_fixes_descendants():
    table = IdTable()
    child = table.alloc("/dir/child.txt")
    table.rename("/dir", "/moved")
    assert table.resolve(child) == "/moved/child.txt"


def test_path_lookup_reports_membership():
    table = IdTable()
    table.alloc("/a.txt")
    assert table.id_for("/a.txt") is not None
    assert table.id_for("/missing.txt") is None


def test_ids_survive_concurrent_allocation_on_the_loop():

    async def run() -> int:
        table = IdTable()
        results = await asyncio.gather(
            *(asyncio.to_thread(table.alloc, f"/f{i}.txt") for i in range(50)))
        return len(set(results))

    assert asyncio.run(run()) == 50

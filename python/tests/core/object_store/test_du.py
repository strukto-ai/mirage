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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.object_store.du import make_du_entries, make_du_size
from mirage.core.object_store.find import make_find
from mirage.core.object_store.readdir import make_readdir
from mirage.types import PathSpec
from tests.core.object_store.conftest import (FakeAccessor, FakeStore,
                                              make_driver, spec)

_STORE = {
    "data/a.txt": b"12345",
    "data/sub/b.txt": b"123",
    "data-old/c.txt": b"1",
}


def test_du_entries_reports_sizes_and_total(accessor):
    entries = make_du_entries(make_driver(FakeStore(_STORE)))
    found, total = asyncio.run(entries(accessor, spec("/data")))
    assert found == [("/data/a.txt", 5), ("/data/sub/b.txt", 3)]
    assert total == 8


def test_du_size_matches_the_entries_total(accessor):
    driver = make_driver(FakeStore(_STORE))
    found, total = asyncio.run(
        make_du_entries(driver)(accessor, spec("/data")))
    assert asyncio.run(make_du_size(driver)(accessor, spec("/data"))) == total


def test_du_of_a_single_file_counts_just_it(accessor):
    size = make_du_size(make_driver(FakeStore(_STORE)))
    assert asyncio.run(size(accessor, spec("/data/a.txt"))) == 5


@pytest.mark.asyncio
async def test_walks_share_complete_index(accessor):
    store = FakeStore(_STORE)
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    entries = make_du_entries(driver)
    cold = await entries(accessor, spec('/data'), index)
    store.connects = 0
    assert await entries(accessor, spec('/data'), index) == cold
    assert await make_find(driver)(accessor,
                                   spec('/data'),
                                   type='f',
                                   index=index) == [
                                       '/data/a.txt', '/data/sub/b.txt'
                                   ]
    assert await make_readdir(driver)(accessor, spec('/data/sub'),
                                      index) == ['/mnt/data/sub/b.txt']
    assert store.connects == 0
    await index.invalidate()
    await entries(accessor, spec('/data'), index)
    assert store.connects == 1


@pytest.mark.asyncio
async def test_readdir_warms_only_complete_subtrees(accessor):
    store = FakeStore(_STORE)
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    readdir = make_readdir(driver)
    await readdir(accessor, spec('/data'), index)
    store.connects = 0
    assert await make_du_size(driver)(accessor, spec('/data'), index) == 8
    assert store.connects == 1
    store.connects = 0
    assert await make_du_size(driver)(accessor, spec('/data/a.txt'),
                                      index) == 5
    assert store.connects == 0


@pytest.mark.asyncio
async def test_filtered_find_never_publishes_partial_listing(accessor):
    store = FakeStore(_STORE)
    driver = make_driver(store, find_narrowing=True)
    index = RAMIndexCacheStore()
    assert await make_find(driver)(accessor,
                                   spec('/data'),
                                   name='a.txt',
                                   type='f',
                                   index=index) == ['/data/a.txt']
    assert (await index.list_dir('/mnt/data')).entries is None
    assert await make_du_size(driver)(accessor, spec('/data'), index) == 8


@pytest.mark.asyncio
@pytest.mark.parametrize('objects', [
    {
        'data/': b''
    },
    {
        'data': b'root',
        'data/sub.txt': b'child'
    },
    {
        'data/a': b'file',
        'data/a/b': b'deep'
    },
])
async def test_markers_and_file_prefix_collisions_remain_consistent(
        accessor, objects):
    driver = make_driver(FakeStore(objects))
    index = RAMIndexCacheStore()
    entries = make_du_entries(driver)
    expected = await entries(accessor, spec('/data'))
    await make_readdir(driver)(accessor, spec('/'), index)
    await make_readdir(driver)(accessor, spec('/data'), index)
    assert await entries(accessor, spec('/data'), index) == expected
    assert await entries(accessor, spec('/data'), index) == expected


@pytest.mark.asyncio
async def test_find_cannot_hide_a_coexisting_file_root(accessor):
    driver = make_driver(FakeStore({
        'data': b'root',
        'data/sub.txt': b'child'
    }))
    index = RAMIndexCacheStore()
    await make_find(driver)(accessor, spec('/data'), index=index)
    assert await make_du_size(driver)(accessor, spec('/data'), index) == 9


@pytest.mark.asyncio
async def test_warm_tree_preserves_key_prefix_and_metadata():
    accessor = FakeAccessor('team/')
    driver = make_driver(FakeStore({'team/data/a.txt': b'123'}))
    index = RAMIndexCacheStore()
    await make_du_size(driver)(accessor, spec('/data'), index)
    assert await make_find(driver)(accessor,
                                   spec('/data'),
                                   type='f',
                                   index=index) == ['/data/a.txt']
    assert (await index.get('/mnt/data/a.txt')).entry.size == 3


@pytest.mark.asyncio
@pytest.mark.parametrize('warmup', ['find', 'du'])
@pytest.mark.parametrize('virtual', ['/', '/mnt'])
@pytest.mark.parametrize('objects', [{'/': b''}, {'/': b'', 'a.txt': b'abc'}])
async def test_root_marker_never_becomes_its_own_child(accessor, warmup,
                                                       virtual, objects):
    store = FakeStore(objects)
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    root = PathSpec(virtual=virtual, directory=virtual, vfs_path='')
    find = make_find(driver)
    size = make_du_size(driver)
    expected = await find(accessor, root)
    if warmup == 'find':
        await find(accessor, root, index=index)
    else:
        await size(accessor, root, index)
    children = (await index.list_dir(virtual)).entries
    assert children is not None
    assert all(child.rstrip('/') != virtual.rstrip('/') for child in children)
    store.connects = 0
    assert await size(accessor, root, index) == sum(map(len, objects.values()))
    assert await find(accessor, root, index=index) == expected
    assert store.connects == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('objects', [_STORE, {'data/': b''}])
@pytest.mark.parametrize('prefix', ['', 'team/'])
async def test_find_warms_du_without_relisting(objects, prefix):
    accessor = FakeAccessor(prefix)
    store = FakeStore({prefix + key: value for key, value in objects.items()})
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    path = spec('/data')
    entries = make_du_entries(driver)
    expected = await entries(accessor, path)
    await make_find(driver)(accessor, path, index=index)
    store.connects = 0
    assert await entries(accessor, path, index) == expected
    assert await entries(accessor, path, index) == expected
    assert store.connects == 0

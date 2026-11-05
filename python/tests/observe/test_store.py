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

from mirage.observe.store import ObserverStore, RAMObserverStore


def test_append_creates_and_extends():
    store = RAMObserverStore()
    asyncio.run(store.append("/d/s.jsonl", b"a\n"))
    asyncio.run(store.append("/d/s.jsonl", b"b\n"))
    files = asyncio.run(store.read_all())
    assert files == {"/d/s.jsonl": b"a\nb\n"}


def test_write_overwrites():
    store = RAMObserverStore()
    asyncio.run(store.append("/d/s.jsonl", b"old\n"))
    asyncio.run(store.write("/d/s.jsonl", b"new\n"))
    files = asyncio.run(store.read_all())
    assert files == {"/d/s.jsonl": b"new\n"}


def test_read_all_returns_copy():
    store = RAMObserverStore()
    asyncio.run(store.append("/d/s.jsonl", b"a\n"))
    files = asyncio.run(store.read_all())
    files["/d/s.jsonl"] = b"mutated"
    assert asyncio.run(store.read_all()) == {"/d/s.jsonl": b"a\n"}


def test_ram_store_satisfies_protocol():
    assert isinstance(RAMObserverStore(), ObserverStore)


def test_read_matching_filters_by_suffix():
    store = RAMObserverStore()
    asyncio.run(store.append("/d1/s1.jsonl", b"a\n"))
    asyncio.run(store.append("/d1/s2.jsonl", b"b\n"))
    asyncio.run(store.append("/d2/s1.jsonl", b"c\n"))
    files = asyncio.run(store.read_matching("/s1.jsonl"))
    assert files == {"/d1/s1.jsonl": b"a\n", "/d2/s1.jsonl": b"c\n"}


def test_clear_empties_store():
    store = RAMObserverStore()
    asyncio.run(store.append("/d/s.jsonl", b"a\n"))
    asyncio.run(store.clear())
    assert asyncio.run(store.read_all()) == {}


def test_past_its_cap_the_oldest_lines_go_first():
    store = RAMObserverStore(max_bytes=8)
    asyncio.run(store.append("/d1/s.jsonl", b"a1\n"))
    asyncio.run(store.append("/d2/s.jsonl", b"b2\n"))
    asyncio.run(store.append("/d2/s.jsonl", b"c3\n"))
    assert asyncio.run(store.read_all()) == {"/d2/s.jsonl": b"b2\nc3\n"}
    asyncio.run(store.append("/d2/s.jsonl", b"d4\ne5\n"))
    assert asyncio.run(store.read_all()) == {"/d2/s.jsonl": b"d4\ne5\n"}

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
import os
import time
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from mirage.cache.index import LookupStatus
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.cache.index.store import IndexCacheStore
from mirage.types import FileStat, FileType
from mirage.utils.clock import ManualClock

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def store(redis_prefix):
    s = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix=redis_prefix)
    await s.clear()
    yield s
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_list_dir_expired(store):
    entries = [
        (
            "file.txt",
            FileStat(name="F", type=FileType.FILE, fingerprint="f"),
        ),
    ]
    past = datetime.now(timezone.utc) + timedelta(seconds=1)
    await store.set_dir("/dir", entries, expired_at=past)
    time.sleep(1.5)
    result = await store.list_dir("/dir")
    assert result.status == LookupStatus.EXPIRED


@pytest.mark.asyncio
async def test_key_prefix_isolation(redis_prefix):
    s1 = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}ns1:"
    )
    s2 = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}ns2:"
    )
    await s1.clear()
    await s2.clear()
    await s1.put(
        "/shared", FileStat(name="a", type=FileType.FILE, fingerprint="a")
    )
    assert (await s2.get("/shared")).status == LookupStatus.NOT_FOUND
    assert (await s1.get("/shared")).entry is not None
    await s1.clear()
    await s2.clear()
    await s1.close()
    await s2.close()


# The one wire format: what pydantic writes for a FileStat, snake_case and
# every field. `redis.test.ts` pins the same literal, so a row either
# language writes is one the other reads.
ENTRY_WIRE = (
    '{"name":"a.txt","size":6,"modified":"2026-01-01T00:00:00Z",'
    '"fingerprint":"/a.txt","revision":null,"type":"file","content":null,'
    '"mode":null,"uid":null,"gid":null,"atime":null,"ctime":null,'
    '"birthtime":null,"dev":null,"extra":{}}'
)


@pytest.mark.asyncio
async def test_entry_wire_format_is_the_shared_json(store):
    await store.put(
        "/a.txt",
        FileStat(
            name="a.txt",
            type=FileType.FILE,
            size=6,
            modified="2026-01-01T00:00:00Z",
            fingerprint="/a.txt",
        ),
    )
    assert await store._client.get(store._entry_key("/a.txt")) == ENTRY_WIRE


def _row(name: str) -> FileStat:
    return FileStat(name=name, type=FileType.FILE, fingerprint=name)


LISTED = [("a", _row("a")), ("b", _row("b"))]


@pytest.fixture
def mgets(store, monkeypatch):
    sent: list[tuple[str, ...]] = []
    mget = store._client.mget

    async def counted(*keys):
        sent.append(keys)
        return await mget(*keys)

    monkeypatch.setattr(store._client, "mget", counted)
    return sent


@pytest_asyncio.fixture()
async def peer(redis_prefix):
    s = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix=redis_prefix)
    yield s
    await s.close()


async def _seed(store: RedisIndexCacheStore) -> None:
    store.seed(
        {"/d/c": _row("c")},
        {"/d": ["/d/a", "/d/b", "/d/c"]},
        datetime.now(timezone.utc) + timedelta(seconds=60),
    )


async def _replace(store: RedisIndexCacheStore) -> None:
    assert await store.replace_if_unchanged(
        "/d/a",
        _row("a").model_dump_json(),
        _row("a").model_copy(update={"fingerprint": "new"}),
    )


COUNTING = {
    "seed": _seed,
    "add_entry": lambda s: s.add_entry("/d/c", _row("c")),
    "set_dir": lambda s: s.set_dir("/d", [("a", _row("a"))]),
    "set_partial_dir": lambda s: s.set_partial_dir("/d", [("c", _row("c"))]),
    "invalidate_entry": lambda s: s.invalidate_entry("/d/a"),
    "invalidate_dir": lambda s: s.invalidate_dir("/d"),
    "invalidate_prefix": lambda s: s.invalidate_prefix("/d"),
    "invalidate": lambda s: s.invalidate(),
    "clear": lambda s: s.clear(),
}

NOT_COUNTING = {
    "put": lambda s: s.put(
        "/d/a", _row("a").model_copy(update={"fingerprint": "new"})
    ),
    "replace_if_unchanged": _replace,
}

READS = {
    "ttl",
    "clock",
    "scope_snapshot",
    "get",
    "get_many",
    "list_dir",
    "report_gone",
    "entries",
    "listed_this_command",
    "holds_subtree",
    "close",
}


@pytest.mark.asyncio
@pytest.mark.parametrize("method", sorted(COUNTING))
async def test_a_listing_write_is_seen_by_the_same_command(
    store, peer, method
):
    await store.set_dir("/d", LISTED)
    async with command_scope():
        before = await store.list_dir("/d")
        await COUNTING[method](store)
        after = await store.list_dir("/d")
    assert after == await peer.list_dir("/d")
    assert after != before


@pytest.mark.asyncio
@pytest.mark.parametrize("method", sorted(NOT_COUNTING))
async def test_a_row_write_keeps_the_listing_read(store, mgets, method):
    await store.set_dir("/d", LISTED)
    mgets.clear()
    async with command_scope():
        before = await store.list_dir("/d")
        await NOT_COUNTING[method](store)
        after = await store.list_dir("/d")
    assert after == before
    assert len(mgets) == 1
    assert (await store.get("/d/a")).entry.fingerprint == "new"


def test_every_store_method_is_classified():
    public = {
        name
        for owner in (IndexCacheStore, RedisIndexCacheStore)
        for name in vars(owner)
        if not name.startswith("_")
    }
    assert public == READS | COUNTING.keys() | NOT_COUNTING.keys()


@pytest.mark.asyncio
async def test_a_write_on_another_keyspace_keeps_the_listing_read(
    store, mgets, redis_prefix
):
    other = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}other:"
    )
    await store.set_dir("/d", LISTED)
    mgets.clear()
    try:
        async with command_scope():
            await store.list_dir("/d")
            await other.set_dir("/d", [("z", _row("z"))])
            await store.list_dir("/d")
    finally:
        await other.clear()
        await other.close()
    assert len(mgets) == 1


@pytest.mark.asyncio
async def test_a_listing_read_in_a_command_ends_at_its_store_clock_expiry(
    redis_prefix,
):
    clock = ManualClock(start=4_000_000_000.0)
    store = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=redis_prefix, clock=clock
    )
    try:
        await store.set_dir("/d", LISTED)
        async with command_scope():
            assert (await store.list_dir("/d")).entries == ["/d/a", "/d/b"]
            clock.advance(60)
            after = await store.list_dir("/d")
        assert after.status is LookupStatus.EXPIRED
    finally:
        await store.clear()
        await store.close()


@pytest.mark.asyncio
async def test_a_peer_store_write_on_the_keyspace_is_seen(store, peer):
    await store.set_dir("/d", LISTED)
    async with command_scope():
        await store.list_dir("/d")
        await peer.invalidate_entry("/d/a")
        after = await store.list_dir("/d")
    assert after.partial_entries == ["/d/b"]


@pytest.mark.asyncio
async def test_a_peer_store_seed_is_seen_once_flushed(store, peer):
    await store.set_dir("/d", LISTED)
    async with command_scope():
        await _seed(peer)
        await store.list_dir("/d")
        await peer.get("/d/c")
        after = await store.list_dir("/d")
    assert after.entries == ["/d/a", "/d/b", "/d/c"]


@pytest.mark.asyncio
async def test_a_read_during_an_unfinished_write_is_not_kept(
    store, monkeypatch
):
    await store.set_dir("/d", LISTED)
    evaluate = store._client.eval
    entered = asyncio.Event()
    release = asyncio.Event()

    async def held(*args):
        entered.set()
        await release.wait()
        return await evaluate(*args)

    monkeypatch.setattr(store._client, "eval", held)
    async with command_scope():
        writing = asyncio.create_task(store.invalidate_entry("/d/a"))
        await entered.wait()
        assert (await store.list_dir("/d")).entries == ["/d/a", "/d/b"]
        release.set()
        await writing
        after = await store.list_dir("/d")
    assert after.partial_entries == ["/d/b"]


@pytest.mark.asyncio
async def test_a_missing_or_expired_listing_is_read_each_time(store, mgets):
    await store.set_dir("/d", LISTED)
    await store.invalidate()
    mgets.clear()
    async with command_scope():
        for folder, status in (
            ("/missing", LookupStatus.NOT_FOUND),
            ("/d", LookupStatus.EXPIRED),
        ):
            for _ in range(2):
                assert (await store.list_dir(folder)).status is status
    assert len(mgets) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("method", sorted(NOT_COUNTING))
@pytest.mark.parametrize("writer", ["self", "peer"])
async def test_row_batches_see_row_writes_without_reloading_membership(
    store, peer, mgets, method, writer
):
    await store.set_dir("/d", LISTED)
    mgets.clear()
    async with command_scope():
        await store.list_dir("/d")
        assert (await store.get("/d/a")).entry.fingerprint != "new"
        await NOT_COUNTING[method](store if writer == "self" else peer)
        assert (await store.get("/d/a")).entry.fingerprint == "new"
        await store.get("/d/b")
    assert len(mgets) == 3


@pytest.mark.asyncio
async def test_a_row_write_leaves_its_siblings_batched(store, mgets):
    await store.set_dir("/d", LISTED)
    mgets.clear()
    async with command_scope():
        await store.list_dir("/d")
        for name in ("a", "b"):
            path = f"/d/{name}"
            row = (await store.get(path)).entry
            assert await store.replace_if_unchanged(
                path,
                row.model_dump_json(),
                row.model_copy(update={"fingerprint": "new"}),
            )
    assert len(mgets) == 2


@pytest.mark.asyncio
async def test_a_new_command_reads_rows_changed_outside_the_process(
    store, mgets
):
    await store.set_dir("/d", LISTED)
    async with command_scope():
        await store.list_dir("/d")
        await store.get("/d/a")
    await store._client.set(
        store._entry_key("/d/a"),
        _row("a")
        .model_copy(update={"fingerprint": "external"})
        .model_dump_json(),
    )
    async with command_scope():
        await store.list_dir("/d")
        assert (await store.get("/d/a")).entry.fingerprint == "external"

import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
import pytest_asyncio
from fakeredis.aioredis import FakeRedis
from redis.asyncio import Redis

from mirage.cache.index import redis as redis_index
from mirage.cache.index.config import IndexEntry, LookupStatus
from mirage.cache.index.constants import (
    CHILDREN_PREFIX,
    ENTRY_PREFIX,
    REGISTRY_PAGE,
)
from mirage.cache.index.redis import RedisIndexCacheStore


@pytest_asyncio.fixture(params=["fake", "redis"])
async def rolling_client(request):
    url = os.environ.get("REDIS_URL")
    if request.param == "redis" and not url:
        pytest.skip("REDIS_URL not set")
    client = (
        FakeRedis(decode_responses=True)
        if request.param == "fake"
        else Redis.from_url(url, decode_responses=True)
    )
    prefix = f"rolling:{uuid4()}:"
    try:
        yield client, prefix
    finally:
        keys = [key async for key in client.scan_iter(match=f"{prefix}*")]
        if keys:
            await client.delete(*keys)
        await client.aclose()


@pytest.fixture
def client():
    value = MagicMock()
    value.scan = AsyncMock(
        return_value=(
            0,
            [b"test:mirage:idx:entry:/folder/a.txt"],
        )
    )
    value.mget = AsyncMock(
        return_value=[
            b'{"entries":["/folder/a.txt"],"expires_at":4102444800,"generation":"g:d"}',
            b"g",
            b"d",
        ]
    )
    value.set = AsyncMock()
    value.delete = AsyncMock()
    value.get = AsyncMock(
        return_value=(b'{"id":"a","name":"a.txt","resource_type":"file"}')
    )
    pipe = MagicMock()
    pipe.execute = AsyncMock()
    value.pipeline.return_value = pipe
    return value


@pytest.mark.asyncio
async def test_list_dir_decodes_injected_client_values(client):
    store = RedisIndexCacheStore(client=client)
    result = await store.list_dir("/folder")
    assert result.entries == ["/folder/a.txt"]
    client.mget.assert_awaited_once_with(
        "mirage:idx:directory:/folder",
        "mirage:idx:generation",
        "mirage:idx:generation:/folder",
    )


@pytest.mark.asyncio
async def test_invalidate_dir_is_one_script_over_its_three_keys(client):
    # The rows go and the child list becomes a tombstone in one step, so no
    # writer lands between reading the listing and dropping it.
    client.eval = AsyncMock()
    store = RedisIndexCacheStore(client=client)
    await store.invalidate_dir("/folder")
    args = client.eval.await_args.args
    assert args[1:5] == (
        4,
        "mirage:idx:directory:/folder",
        "mirage:idx:tombstone:/folder",
        "mirage:idx:generation:/folder",
    )


@pytest.mark.asyncio
async def test_entries_decodes_keys_and_json(client):
    store = RedisIndexCacheStore(client=client, key_prefix="test:")
    entries = await store.entries()
    assert entries["/folder/a.txt"].id == "a"


@pytest.mark.asyncio
async def test_falsey_injected_client_is_used_and_not_closed(client):
    client.__bool__.return_value = False
    store = RedisIndexCacheStore(client=client)

    await store.get("/folder/a.txt")
    await store.close()
    await store.close()

    client.get.assert_awaited_once()
    client.aclose.assert_not_called()


@pytest.mark.asyncio
async def test_seed_flushes_before_first_lookup(client):
    client.mget.return_value = [b"d"]
    store = RedisIndexCacheStore(client=client)
    store.seed(
        {
            "/folder/a.txt": IndexEntry(
                id="a", name="a.txt", resource_type="file"
            )
        },
        {"/folder": ["/folder/a.txt"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )

    client.get.return_value = None
    await store.get("/folder/a.txt")

    client.pipeline.return_value.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_failed_seed_flush_remains_retryable(client):
    client.get.return_value = b"g"
    client.mget.return_value = [b"d"]
    store = RedisIndexCacheStore(client=client)
    store.seed(
        {"/a": IndexEntry(id="a", name="a", resource_type="file")},
        {"/": ["/a"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )
    pipe = client.pipeline.return_value
    pipe.execute.side_effect = [ConnectionError("retry"), None]
    with pytest.raises(ConnectionError, match="retry"):
        await store.close()
    await store.close()
    assert pipe.execute.await_count == 2
    assert pipe.set.call_args_list[:2] == pipe.set.call_args_list[2:]


@pytest.mark.asyncio
async def test_concurrent_readers_flush_each_seed_once(client):
    client.get.return_value = None
    client.mget.return_value = [b"d"]
    store = RedisIndexCacheStore(client=client)
    store.seed(
        {"/a": IndexEntry(id="a", name="a", resource_type="file")},
        {"/": ["/a"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )
    await asyncio.gather(store.get("/a"), store.get("/a"))
    client.pipeline.return_value.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_evicted_generation_cannot_revive_invalidated_listing():
    client = FakeRedis()
    store = RedisIndexCacheStore(client=client)
    try:
        await store.set_dir("/old", [])
        await store.invalidate()
        await client.delete("mirage:idx:generation")
        assert (await store.list_dir("/old")).status == LookupStatus.EXPIRED
        await store.set_dir("/new", [])
        assert (await store.list_dir("/new")).entries == []
        assert (await store.list_dir("/old")).status == LookupStatus.EXPIRED
    finally:
        await store.close()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("empty", [False, True])
@pytest.mark.parametrize("seed", [False, True])
async def test_global_invalidation_expires_year_long_listings(
    rolling_client, empty, seed
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    row = IndexEntry(id="old", name="old.txt", resource_type="file")
    deadline = datetime.now(timezone.utc) + timedelta(days=365)
    rows = [] if empty else [("old.txt", row)]
    try:
        if seed:
            store.seed(
                {f"/repo/{name}": entry for name, entry in rows},
                {"/repo": [f"/repo/{name}" for name, _ in rows]},
                deadline,
            )
        else:
            await store.set_dir("/repo", rows, expired_at=deadline)
        assert (await store.list_dir("/repo")).entries == [
            f"/repo/{name}" for name, _ in rows
        ]

        await RedisIndexCacheStore(
            client=client, key_prefix=prefix
        ).invalidate()
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/other", [])
        assert (await store.list_dir("/other")).entries == []
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [("new.txt", row)])
        assert (await store.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_invalidation_between_generation_and_seed_commit_stays_expired(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_pipeline = client.pipeline

    def delayed_pipeline():
        pipe = original_pipeline()
        execute = pipe.execute

        async def execute_after_clear():
            await RedisIndexCacheStore(
                client=client, key_prefix=prefix
            ).invalidate()
            return await execute()

        pipe.execute = execute_after_clear
        return pipe

    try:
        monkeypatch.setattr(client, "pipeline", delayed_pipeline)
        store.seed(
            {}, {"/repo": []}, datetime.now(timezone.utc) + timedelta(days=365)
        )
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        monkeypatch.setattr(client, "pipeline", original_pipeline)
        await store.set_dir("/other", [])
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation", ["invalidate_dir", "invalidate_prefix", "clear"]
)
async def test_scoped_invalidations_respect_literal_namespaces(
    rolling_client, operation
):
    client, prefix = rolling_client
    stores = [
        RedisIndexCacheStore(client=client, key_prefix=prefix + suffix)
        for suffix in ("literal[1]:", "literal1:")
    ]
    store, neighbor = stores
    row = IndexEntry(id="a", name="a.txt", resource_type="file")
    try:
        for target in stores:
            for directory in ("/repo[1]", "/repo1"):
                await target.set_dir(directory, [("a.txt", row)])
        if operation == "clear":
            await store.clear()
        else:
            await getattr(store, operation)("/repo[1]")
        assert (
            await store.get("/repo[1]/a.txt")
        ).status == LookupStatus.NOT_FOUND
        assert (
            await store.list_dir("/repo[1]")
        ).status == LookupStatus.NOT_FOUND
        assert (await neighbor.list_dir("/repo[1]")).entries == [
            "/repo[1]/a.txt"
        ]
        assert (await neighbor.list_dir("/repo1")).entries == ["/repo1/a.txt"]
        if operation != "clear":
            assert (await store.list_dir("/repo1")).entries == ["/repo1/a.txt"]
    finally:
        for target in stores:
            await target.close()


@pytest.mark.asyncio
async def test_evicted_directory_token_cannot_revive_restored_listing(
    rolling_client,
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    try:
        await store.set_dir("/repo", [])
        payload_key = f"{prefix}mirage:idx:directory:/repo"
        original = await client.get(payload_key)
        await client.delete(f"{prefix}mirage:idx:generation:/repo")
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [])
        assert (await store.list_dir("/repo")).entries == []
        await client.set(payload_key, original)
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_seed_directory_tokens_use_bounded_round_trips(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    get = MagicMock(wraps=client.get)
    mget = MagicMock(wraps=client.mget)
    pipeline = MagicMock(wraps=client.pipeline)
    monkeypatch.setattr(client, "get", get)
    monkeypatch.setattr(client, "mget", mget)
    monkeypatch.setattr(client, "pipeline", pipeline)
    try:
        store.seed(
            {},
            {f"/repo/{i}": [] for i in range(1000)},
            datetime.now(timezone.utc) + timedelta(days=365),
        )
        assert (await store.list_dir("/repo/0")).entries == []
        assert get.call_count == 1
        assert mget.call_count == 2
        assert pipeline.call_count == 2
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_batched_initialization_preserves_observed_tokens(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    try:
        await store.set_dir("/present", [])
        original_pipeline = client.pipeline

        def invalidate_during_pipeline():
            pipe = original_pipeline()
            execute = pipe.execute

            async def execute_after_invalidation():
                await client.set(
                    f"{prefix}mirage:idx:generation:/present", "replacement"
                )
                return await execute()

            pipe.execute = execute_after_invalidation
            return pipe

        monkeypatch.setattr(client, "pipeline", invalidate_during_pipeline)
        store.seed(
            {},
            {"/present": [], "/missing": []},
            datetime.now(timezone.utc) + timedelta(days=365),
        )
        assert (
            await store.list_dir("/present")
        ).status == LookupStatus.EXPIRED
        assert (await store.list_dir("/missing")).entries == []
    finally:
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("timing", ["before", "after"])
@pytest.mark.parametrize("scope", ["global", "directory"])
async def test_scalar_initialization_does_not_adopt_replacement_tokens(
    rolling_client, monkeypatch, timing, scope
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    writer = RedisIndexCacheStore(client=client, key_prefix=prefix)
    generation_key = f"{prefix}mirage:idx:generation"
    target = generation_key if scope == "global" else f"{generation_key}:/repo"
    original_set = client.set
    original_pipeline = client.pipeline
    fresh = IndexEntry(id="new", name="new.txt", resource_type="file")
    stale = IndexEntry(id="old", name="old.txt", resource_type="file")

    async def refill():
        await writer.set_dir("/repo", [("new.txt", fresh)])
        if scope == "global":
            await writer.invalidate()
        else:
            await writer.invalidate_dir("/repo")
        await writer.set_dir("/repo", [("new.txt", fresh)])

    async def set_during_refill(key, value, **options):
        if key != target or not options.get("nx"):
            return await original_set(key, value, **options)
        monkeypatch.setattr(client, "set", original_set)
        if timing == "before":
            await refill()
        result = await original_set(key, value, **options)
        if timing == "after":
            await refill()
        return result

    def pipeline_during_refill():
        pipe = original_pipeline()
        execute = pipe.execute

        async def execute_during_refill():
            monkeypatch.setattr(client, "pipeline", original_pipeline)
            if timing == "before":
                await refill()
            result = await execute()
            if timing == "after":
                await refill()
            return result

        pipe.execute = execute_during_refill
        return pipe

    try:
        if scope == "global":
            monkeypatch.setattr(client, "set", set_during_refill)
        else:
            monkeypatch.setattr(client, "pipeline", pipeline_during_refill)
        await store.set_dir(
            "/repo",
            [("old.txt", stale)],
            expired_at=datetime.now(timezone.utc) + timedelta(days=365),
        )
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [("new.txt", fresh)])
        assert (await store.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        await store.close()
        await writer.close()


@pytest.mark.asyncio
async def test_parallel_cold_directory_writes_remain_fresh(rolling_client):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    paths = [f"/repo/{i}" for i in range(20)]
    try:
        await asyncio.gather(*(store.set_dir(path, []) for path in paths))
        for path in paths:
            assert (await store.list_dir(path)).entries == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_shared_generation_failure_can_retry(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_get = client.get

    async def fail(key):
        await asyncio.sleep(0)
        raise ConnectionError(key)

    try:
        monkeypatch.setattr(client, "get", fail)
        results = await asyncio.gather(
            store.set_dir("/a", []),
            store.set_dir("/b", []),
            return_exceptions=True,
        )
        assert all(isinstance(result, ConnectionError) for result in results)
        monkeypatch.setattr(client, "get", original_get)
        await asyncio.gather(store.set_dir("/a", []), store.set_dir("/b", []))
        assert (await store.list_dir("/a")).entries == []
        assert (await store.list_dir("/b")).entries == []
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_cancelled_generation_waiter_does_not_cancel_peer(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_get = client.get
    started = asyncio.Event()
    release = asyncio.Event()

    async def delayed_get(key):
        started.set()
        await release.wait()
        return await original_get(key)

    try:
        monkeypatch.setattr(client, "get", delayed_get)
        cancelled = asyncio.create_task(store.set_dir("/cancelled", []))
        survivor = asyncio.create_task(store.set_dir("/survivor", []))
        await started.wait()
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        release.set()
        await survivor
        assert (await store.list_dir("/survivor")).entries == []
    finally:
        release.set()
        await store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("timing", ["before", "after"])
async def test_seed_initialization_does_not_adopt_replacement_tokens(
    rolling_client, monkeypatch, timing
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    writer = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original_pipeline = client.pipeline
    fresh = IndexEntry(id="new", name="new.txt", resource_type="file")

    async def refill():
        await writer.set_dir("/repo", [("new.txt", fresh)])
        await writer.invalidate_dir("/repo")
        await writer.set_dir("/repo", [("new.txt", fresh)])

    def pipeline_during_refill():
        monkeypatch.setattr(client, "pipeline", original_pipeline)
        pipe = original_pipeline()
        execute = pipe.execute

        async def execute_during_refill():
            if timing == "before":
                await refill()
            result = await execute()
            if timing == "after":
                await refill()
            return result

        pipe.execute = execute_during_refill
        return pipe

    try:
        monkeypatch.setattr(client, "pipeline", pipeline_during_refill)
        store.seed(
            {
                "/repo/old.txt": IndexEntry(
                    id="old", name="old.txt", resource_type="file"
                )
            },
            {"/repo": ["/repo/old.txt"]},
            datetime.now(timezone.utc) + timedelta(days=365),
        )
        assert (await store.list_dir("/repo")).status == LookupStatus.EXPIRED
        await store.set_dir("/repo", [("new.txt", fresh)])
        assert (await store.list_dir("/repo")).entries == ["/repo/new.txt"]
    finally:
        await store.close()
        await writer.close()


@pytest.mark.asyncio
async def test_subtree_eviction_finishes_before_a_newer_listing(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    first = RedisIndexCacheStore(client=client, key_prefix=prefix)
    second = RedisIndexCacheStore(client=client, key_prefix=prefix)
    folder = IndexEntry(id="sub", name="sub", resource_type="folder")
    child = IndexEntry(id="new", name="new", resource_type="file")
    await first.set_dir("/d", [("sub", folder)])
    await first.set_dir("/d/sub", [("new", child)])
    evaluate = client.eval
    interleave = True

    async def recreate_after_swap(*args, **kwargs):
        nonlocal interleave
        result = await evaluate(*args, **kwargs)
        if interleave:
            interleave = False
            await second.set_dir("/d", [("sub", folder)])
            await second.set_dir("/d/sub", [("new", child)])
        return result

    monkeypatch.setattr(client, "eval", recreate_after_swap)
    await first.set_dir("/d", [])
    assert (await second.get("/d/sub")).entry is not None
    assert (await second.list_dir("/d/sub")).entries == ["/d/sub/new"]
    assert (await second.get("/d/sub/new")).entry is not None


@pytest.mark.asyncio
async def test_subtree_eviction_does_not_scan_unrelated_keys(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    folder = IndexEntry(id="sub", name="sub", resource_type="folder")
    child = IndexEntry(id="child", name="child", resource_type="file")
    await store.set_dir("/d", [("sub", folder)])
    await store.put("/d/sub/unlisted/deep", child)
    store.seed(
        {f"/other/{i}": child for i in range(200)},
        {},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )
    await store.get("/other/0")
    await client.set(prefix + "unrelated", "keep")
    evaluate = client.eval

    async def forbid_scan(script, *args, **kwargs):
        guarded = (
            """
local call = redis.call
local redis = {call = function(command, ...)
  if command == 'SCAN' then error('unexpected database scan') end
  return call(command, ...)
end}
"""
            + script
        )
        return await evaluate(guarded, *args, **kwargs)

    monkeypatch.setattr(client, "eval", forbid_scan)
    await store.set_dir("/d", [])
    assert (await store.get("/d/sub/unlisted/deep")).entry is None
    assert (await store.get("/other/0")).entry is not None
    assert await client.get(prefix + "unrelated") == "keep"


@pytest.mark.asyncio
async def test_subtree_eviction_recovers_an_evicted_path_registry(
    rolling_client,
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    folder = IndexEntry(id="sub", name="sub", resource_type="folder")
    child = IndexEntry(id="child", name="child", resource_type="file")
    await store.set_dir("/d", [("sub", folder)])
    await store.put("/d/sub/unlisted/deep", child)
    await store.set_dir("/d/sub/buried", [("child", child)])
    await store.invalidate_dir("/d/sub/buried")
    await client.delete(prefix + "mirage:idx:paths")
    await store.put("/unrelated", child)
    await store.set_dir("/d", [])
    assert (await store.get("/d/sub/unlisted/deep")).entry is None
    assert (
        await client.get(prefix + "mirage:idx:tombstone:/d/sub/buried") is None
    )
    assert (await store.get("/unrelated")).entry is not None


@pytest.mark.asyncio
async def test_path_registry_prunes_removed_rows_but_preserves_tombstones(
    rolling_client,
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    child = IndexEntry(id="child", name="child", resource_type="file")
    registry = prefix + "mirage:idx:paths"
    await store.clear()
    await store.put("/put-only", child)
    await store.invalidate_entry("/put-only")
    assert await client.zrange(registry, 0, -1) == [""]
    await store.set_dir("/d", [("child", child)])
    await store.set_dir("/d", [])
    assert await client.zrange(registry, 0, -1) == ["", "/d"]
    await store.set_dir("/d", [("child", child)])
    await store.invalidate_dir("/d")
    await store.invalidate_prefix("/d")
    assert await client.zrange(registry, 0, -1) == ["", "/d"]
    assert await client.get(prefix + "mirage:idx:tombstone:/d") is not None
    await store.clear()
    assert await client.zrange(registry, 0, -1) == [""]


@pytest.mark.asyncio
async def test_registry_prefix_invalidation_accepts_trailing_slashes(
    rolling_client,
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    child = IndexEntry(id="child", name="child", resource_type="file")
    await store.set_dir("/literal[1]", [("child", child)])
    await store.set_dir("/literal[1]/nested", [("child", child)])
    await store.put("/literal[1]sibling/child", child)
    await store.invalidate_prefix(
        "/literal[1]/", excluded=("/literal[1]/nested/",)
    )
    assert (await store.get("/literal[1]/child")).entry is None
    assert (
        await store.list_dir("/literal[1]")
    ).status == LookupStatus.NOT_FOUND
    assert (await store.get("/literal[1]/nested/child")).entry is not None
    assert (await store.get("/literal[1]sibling/child")).entry is not None


@pytest.mark.asyncio
async def test_cold_registry_recovery_never_scans_inside_lua(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(
        client=client, key_prefix=prefix + "literal[1]:"
    )
    child = IndexEntry(id="child", name="child", resource_type="file")
    await store.put("/d/sub/orphan", child)
    evaluate = client.eval
    pipeline = client.pipeline
    guard = """
local call = redis.call
local redis = {call = function(command, ...)
  if command == 'SCAN' then error('atomic database scan') end
  return call(command, ...)
end}
"""

    async def guarded_eval(script, *args, **kwargs):
        return await evaluate(guard + script, *args, **kwargs)

    def guarded_pipeline():
        pipe = pipeline()
        run = pipe.eval

        def guarded_script(script, *args, **kwargs):
            return run(guard + script, *args, **kwargs)

        pipe.eval = guarded_script
        return pipe

    monkeypatch.setattr(client, "eval", guarded_eval)
    monkeypatch.setattr(client, "pipeline", guarded_pipeline)
    await client.delete(prefix + "literal[1]:mirage:idx:paths")
    await store.set_dir(
        "/d",
        [("sub", IndexEntry(id="sub", name="sub", resource_type="folder"))],
    )
    await store.set_dir("/d", [])
    assert (await store.get("/d/sub/orphan")).entry is None


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["invalidate_prefix", "clear"])
async def test_large_wipes_page_the_registry(
    rolling_client, monkeypatch, operation
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    child = IndexEntry(id="child", name="child", resource_type="file")
    store.seed(
        {f"/d/{i}": child for i in range(400)},
        {},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )
    await store.set_dir("/other", [])
    evaluate = client.eval
    calls = 0

    async def bounded_eval(script, *args, **kwargs):
        nonlocal calls
        calls += 1
        guard = """
local call = redis.call
local redis = {call = function(command, ...)
  if command == 'ZRANGEBYLEX' then
    local args = {...}
    if args[4] ~= 'LIMIT' or tonumber(args[6]) > 128 then
      error('unbounded registry range')
    end
  end
  return call(command, ...)
end}
"""
        return await evaluate(guard + script, *args, **kwargs)

    monkeypatch.setattr(client, "eval", bounded_eval)
    if operation == "clear":
        await store.clear()
    else:
        await store.invalidate_prefix("/d")
    assert calls >= 4
    assert (await store.get("/d/0")).entry is None
    assert (await store.get("/d/399")).entry is None


def _row(name: str) -> tuple[str, IndexEntry]:
    return name, IndexEntry(id=name, name=name, resource_type="file")


@pytest.mark.asyncio
async def test_a_versioned_listing_missing_a_child_row_is_served(
    rolling_client,
):
    # Redis eviction can drop a row while its listing survives. The store
    # serves the listing as written; the reader that finds a listed name
    # with no row refills on demand.
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    await store.set_dir("/d", [_row("a"), _row("b")], version="v1")
    await client.delete(f"{prefix}{ENTRY_PREFIX}/d/b")
    listing = await store.list_dir("/d")
    assert listing.entries == ["/d/a", "/d/b"]
    assert listing.version == "v1"


@pytest.mark.asyncio
async def test_an_empty_versioned_listing_is_served(rolling_client):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    await store.set_dir("/e", [], version="v1")
    listing = await store.list_dir("/e")
    assert listing.entries == []
    assert listing.version == "v1"


@pytest.mark.asyncio
async def test_a_row_without_a_version_key_reads_as_unversioned(
    rolling_client,
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    await store.set_dir("/d", [_row("a")])
    key = f"{prefix}{CHILDREN_PREFIX}/d"
    row = json.loads(await client.get(key))
    row.pop("version", None)
    await client.set(key, json.dumps(row))
    listing = await store.list_dir("/d")
    assert listing.entries == ["/d/a"]
    assert listing.version is None


def test_the_two_inline_lua_copies_are_byte_identical():
    root = Path(__file__).resolve().parents[4]
    source = (
        root / "typescript/packages/core/src/cache/index/redis.ts"
    ).read_text()
    copies = {}
    for match in re.finditer(
        r"const ([A-Z_]+)\s*=\s*(?:([A-Z_]+)\s*\+\s*)?`([^`]*)`", source
    ):
        name, parent, body = match.groups()
        copies[name] = (copies[parent] if parent else "") + body
    originals = {
        name[1:]: value
        for name, value in vars(redis_index).items()
        if name.startswith("_")
        and isinstance(value, str)
        and ("redis.call(" in value or name == "_PATH_RANGE")
    }
    assert copies.keys() == originals.keys()
    for name, original in originals.items():
        assert copies[name].encode() == original.encode(), name


@pytest.mark.asyncio
async def test_registry_recovery_restarts_if_evicted_during_a_scan(
    rolling_client, monkeypatch
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    child = IndexEntry(id="child", name="child", resource_type="file")
    folder = IndexEntry(id="sub", name="sub", resource_type="folder")
    await store.set_dir("/d", [("sub", folder)])
    await store.put("/d/sub/old", child)
    await client.delete(prefix + "mirage:idx:paths")
    scan = client.scan
    evicted = False

    async def scan_during_eviction(*args, **kwargs):
        nonlocal evicted
        result = await scan(*args, **kwargs)
        if not evicted:
            evicted = True
            await client.delete(prefix + "mirage:idx:paths")
            await store.put("/d/sub/new", child)
        return result

    monkeypatch.setattr(client, "scan", scan_during_eviction)
    await store.set_dir("/d", [])
    assert evicted
    assert (await store.get("/d/sub/old")).entry is None
    assert (await store.get("/d/sub/new")).entry is None


@pytest.mark.asyncio
@pytest.mark.parametrize("directory", ["/d", "/d/nested"])
async def test_paged_invalidation_cannot_leave_a_refill_naming_deleted_rows(
    rolling_client, monkeypatch, directory
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    child = IndexEntry(id="child", name="child", resource_type="file")
    await store.set_dir(directory, [(f"{i:03}", child) for i in range(300)])
    evaluate = client.eval
    refilled = False

    async def refill_between_pages(script, *args, **kwargs):
        nonlocal refilled
        result = await evaluate(script, *args, **kwargs)
        if not refilled and "local removed = cjson.decode(ARGV[5])" in script:
            refilled = True
            await store.set_dir(directory, [("000", child), ("zzz", child)])
        return result

    monkeypatch.setattr(client, "eval", refill_between_pages)
    await store.invalidate_prefix("/d")
    assert refilled
    assert (await store.get(directory + "/zzz")).entry is None
    assert (await store.list_dir(directory)).status in (
        LookupStatus.NOT_FOUND,
        LookupStatus.EXPIRED,
    )


@pytest.mark.asyncio
async def test_holds_subtree_sees_a_seed_not_yet_flushed(rolling_client):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    store.seed(
        {"/x/dir/sub/f": IndexEntry(id="f", name="f", resource_type="file")},
        {"/x/dir/sub": ["/x/dir/sub/f"]},
        datetime.now(timezone.utc) + timedelta(hours=1),
    )
    assert await store.holds_subtree("/x/dir") is True


@pytest.mark.asyncio
async def test_holds_subtree_recovers_an_evicted_path_registry(
    rolling_client,
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    child = IndexEntry(id="f", name="f", resource_type="file")
    await store.set_dir("/x/dir/sub", [("f", child)])
    await client.delete(prefix + "mirage:idx:paths")
    # An empty registry would read as "nothing below", so a folder
    # delete would keep its subtree; the probe must rebuild it first.
    assert await store.holds_subtree("/x/dir") is True
    assert await client.zscore(prefix + "mirage:idx:paths", "") is not None


async def _buried(store: RedisIndexCacheStore, count: int) -> None:
    child = IndexEntry(id="g", name="g", resource_type="file")
    for i in range(count):
        await store.set_dir(f"/x/dir/a{i:04}", [("g", child)])
        await store.invalidate_dir(f"/x/dir/a{i:04}")


@pytest.mark.asyncio
async def test_the_subtree_probe_reads_one_registry_page_per_script(
    rolling_client, monkeypatch
):
    # Buried listings stay registered as tombstones; walking all of them
    # in one atomic script would block the shared server for the whole
    # history of the folder.
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    await _buried(store, REGISTRY_PAGE + 12)
    evaluate = client.eval
    probes = []

    async def counted(script, *args, **kwargs):
        if script == redis_index._HOLDS_SUBTREE:
            probes.append(script)
        return await evaluate(script, *args, **kwargs)

    monkeypatch.setattr(client, "eval", counted)
    assert await store.holds_subtree("/x/dir") is False
    assert len(probes) == 2


@pytest.mark.asyncio
async def test_a_live_listing_at_the_end_of_a_full_page_is_found(
    rolling_client,
):
    # The next page starts strictly after the last member read, so the
    # last member of a full page is checked only on that page.
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    await _buried(store, REGISTRY_PAGE - 1)
    child = IndexEntry(id="g", name="g", resource_type="file")
    await store.set_dir("/x/dir/z", [("g", child)])
    assert await store.holds_subtree("/x/dir") is True


@pytest.mark.asyncio
@pytest.mark.parametrize("peer", ["none", "replace", "delete"])
async def test_redis_conditional_replacement_is_atomic(
    rolling_client, monkeypatch, peer
):
    client, prefix = rolling_client
    store = RedisIndexCacheStore(client=client, key_prefix=prefix)
    original = IndexEntry(
        id="a",
        name="a",
        resource_type="file",
        size=2,
        remote_time="2026-09-05T10:55:39.123000Z",
        extra={"nested": {"tags": ["x", "y"]}},
    )
    await store.set_dir("/dir", [("a", original)], version="v1")
    old = (await store.get("/dir/a")).entry
    key = store._entry_key("/dir/a")
    sparse = old.model_dump(exclude_defaults=True)
    await client.set(
        key, json.dumps(dict(reversed(list(sparse.items()))), indent=2)
    )
    raw = await client.get(key)
    listing_key = store._children_key("/dir")
    listing_raw = await client.get(listing_key)
    latest = old.model_copy(update={"size": 9})
    evaluate = client.eval
    calls = 0

    async def raced_eval(script, numkeys, *args):
        nonlocal calls
        calls += 1
        assert numkeys == 1 and args[0] == key and args[1] == raw
        if peer == "replace":
            await client.set(key, latest.model_dump_json())
        elif peer == "delete":
            await client.delete(key)
        return await evaluate(script, numkeys, *args)

    with monkeypatch.context() as patch:
        patch.setattr(client, "eval", raced_eval)
        assert await store.replace_if_unchanged(
            "/dir/a",
            old.model_dump_json(),
            old.model_copy(
                update={
                    "id": "confirmed",
                    "name": "confirmed",
                    "index_time": "",
                }
            ),
        ) is (peer == "none")
    assert calls == 1
    current = (await store.get("/dir/a")).entry
    if peer == "none":
        assert current.id == "confirmed"
    else:
        assert current == (latest if peer == "replace" else None)
    assert await client.get(listing_key) == listing_raw

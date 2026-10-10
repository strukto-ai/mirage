import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from fakeredis.aioredis import FakeRedis
from redis.asyncio import Redis

from mirage.cache.index.config import IndexEntry, ListedMiss, LookupStatus
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.index.warm import entry_or_listed_miss, entry_or_warm
from mirage.errors.fs import enoent, enotdir

KEY = "/owned/notes.json"


def entry_for(entry_id: str) -> IndexEntry:
    return IndexEntry(
        id=entry_id, name="notes", resource_type="gdocs", vfs_name="notes.json"
    )


@pytest.mark.asyncio
async def test_custom_store_default_partial_write_drops_complete_membership():
    index = RAMIndexCacheStore()
    await index.set_dir("/owned", [("old.json", entry_for("old"))])
    # A custom store can inherit the base implementation until it supports
    # freshness for partial directories itself.
    await IndexCacheStore.set_partial_dir(
        index, "/owned", [("notes.json", entry_for("new"))]
    )
    assert (await index.list_dir("/owned")).entries is None
    assert (await index.get("/owned/old.json")).entry is None
    assert (await index.get(KEY)).entry.id == "new"


@pytest.mark.asyncio
async def test_returns_a_warm_hit_without_listing_the_parent():
    index = RAMIndexCacheStore()
    await index.set_dir("/owned", [("notes.json", entry_for("doc-1"))])
    calls = []

    async def warm():
        calls.append(1)

    got = await entry_or_warm(index, KEY, warm)
    assert got is not None and got.id == "doc-1"
    assert not calls


@pytest.mark.asyncio
async def test_lists_the_parent_once_then_serves_what_it_put_there():
    index = RAMIndexCacheStore()
    calls = []

    async def warm():
        calls.append(1)
        await index.put(KEY, entry_for("doc-2"))

    got = await entry_or_warm(index, KEY, warm)
    assert got is not None and got.id == "doc-2"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_returns_none_when_the_listing_did_not_produce_the_entry():
    index = RAMIndexCacheStore()

    async def warm():
        return None

    assert await entry_or_warm(index, KEY, warm) is None


@pytest.mark.asyncio
async def test_returns_none_without_listing_when_there_is_no_parent():
    index = RAMIndexCacheStore()
    assert await entry_or_warm(index, KEY, None) is None


@pytest.mark.asyncio
async def test_swallows_an_absent_parent_so_the_caller_names_the_operand():
    index = RAMIndexCacheStore()

    async def warm():
        raise enoent("/owned")

    assert await entry_or_warm(index, KEY, warm) is None


@pytest.mark.asyncio
async def test_propagates_an_auth_or_transport_failure():
    index = RAMIndexCacheStore()

    async def warm():
        raise RuntimeError("401 Unauthorized")

    with pytest.raises(RuntimeError, match="401 Unauthorized"):
        await entry_or_warm(index, KEY, warm)


@pytest.mark.asyncio
async def test_propagates_a_non_enoent_fs_error_too():
    index = RAMIndexCacheStore()

    async def warm():
        raise enotdir("/owned")

    with pytest.raises(NotADirectoryError):
        await entry_or_warm(index, KEY, warm)


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize(
    "outcome", ["updated", "deleted", "partial", "absent", "error"]
)
async def test_retained_entries_require_a_fresh_parent(backend, outcome):
    client = FakeRedis()
    index = (
        RAMIndexCacheStore()
        if backend == "ram"
        else RedisIndexCacheStore(client=client)
    )
    calls = []

    async def warm():
        calls.append(1)
        if outcome == "absent":
            raise enoent("/owned")
        if outcome == "error":
            raise RuntimeError("unavailable")
        if outcome == "partial":
            await index.put("/owned/other.json", entry_for("other"))
        else:
            rows = (
                [("notes.json", entry_for("new"))]
                if outcome == "updated"
                else []
            )
            await index.set_dir("/owned", rows)

    try:
        await index.set_dir("/owned", [("notes.json", entry_for("old"))])
        await index.invalidate()
        assert (await index.get(KEY)).entry.id == "old"
        if outcome == "error":
            with pytest.raises(RuntimeError, match="unavailable"):
                await entry_or_warm(index, KEY, warm)
        else:
            got = await entry_or_warm(index, KEY, warm)
            assert (got.id if got else None) == (
                "new" if outcome == "updated" else None
            )
        assert calls == [1]
        # A live listing also excludes metadata retained by an earlier refill.
        await index.put(KEY, entry_for("obsolete"))
        await index.set_dir("/owned", [])
        assert await entry_or_warm(index, KEY, warm) is None
        assert calls == [1]
    finally:
        await index.close()
        await client.aclose()


@pytest_asyncio.fixture(params=["ram", "fake", "redis"])
async def orphan_index(request):
    client = None
    if request.param == "ram":
        index = RAMIndexCacheStore()
    else:
        url = os.environ.get("REDIS_URL")
        if request.param == "redis" and not url:
            pytest.skip("REDIS_URL not set")
        client = (
            FakeRedis(decode_responses=True)
            if request.param == "fake"
            else Redis.from_url(url, decode_responses=True)
        )
        index = RedisIndexCacheStore(
            client=client, key_prefix=f"orphan:{uuid4()}:"
        )
    try:
        yield index
    finally:
        await index.clear()
        await index.close()
        if client is not None:
            await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stale", ["expired", "directory", "prefix", "all", "clear"]
)
async def test_partial_membership_is_positive_only_and_expires(
    orphan_index, stale
):
    index = orphan_index
    calls = []

    async def warm():
        calls.append(1)
        await index.set_partial_dir(
            "/owned", [("notes.json", entry_for("new"))]
        )

    await index.set_dir("/owned", [("other.json", entry_for("old"))])
    await index.set_partial_dir(
        "/owned", [("notes.json", entry_for("current"))]
    )
    listing = await index.list_dir("/owned")
    assert listing.entries is None
    assert listing.partial_entries == [KEY]
    assert (await entry_or_warm(index, KEY, warm)).id == "current"
    assert calls == []
    # An omitted row is not a negative cache hit, nor is retained metadata
    # proof of membership in the current page.
    assert await entry_or_warm(index, "/owned/other.json", warm) is None
    assert calls == [1]
    if stale == "expired":
        await index.set_partial_dir(
            "/owned",
            [("notes.json", entry_for("old"))],
            expired_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        )
    elif stale == "directory":
        await index.invalidate_dir("/owned")
    elif stale == "prefix":
        await index.invalidate_prefix("/owned")
    elif stale == "all":
        await index.invalidate()
    else:
        await index.clear()
    assert (await entry_or_warm(index, KEY, warm)).id == "new"
    assert calls == [1, 1]
    assert (await entry_or_warm(index, KEY, warm)).id == "new"
    assert calls == [1, 1]
    await index.set_dir("/owned", [])
    assert (await index.list_dir("/owned")).partial_entries is None
    assert await entry_or_warm(index, KEY, warm) is None
    assert calls == [1, 1]


@pytest.mark.asyncio
@pytest.mark.parametrize("parent_state", ["missing", "invalidated", "expired"])
@pytest.mark.parametrize(
    "outcome",
    [
        "updated",
        "renamed",
        "deleted",
        "partial",
        "partial_updated",
        "absent",
        "error",
    ],
)
async def test_orphaned_metadata_requires_a_current_refresh(
    orphan_index, parent_state, outcome
):
    index = orphan_index
    calls = []

    async def warm():
        calls.append(1)
        if outcome == "absent":
            raise enoent("/owned")
        if outcome == "error":
            raise RuntimeError("unavailable")
        if outcome == "partial":
            await index.put("/owned/other.json", entry_for("other"))
        elif outcome == "partial_updated":
            await index.put(KEY, entry_for("new"))
        elif outcome == "renamed":
            await index.set_dir("/owned", [("renamed.json", entry_for("new"))])
        else:
            rows = (
                [("notes.json", entry_for("new"))]
                if outcome == "updated"
                else []
            )
            await index.set_dir("/owned", rows)

    if parent_state == "expired":
        # This listing never owned the orphan, so invalidate_dir alone
        # cannot remove the stale target before an incomplete refresh.
        await index.set_dir("/owned", [])
    await index.put(KEY, entry_for("old"))
    if parent_state != "missing":
        await index.invalidate()
    assert (await index.get(KEY)).entry.id == "old"
    assert (await index.list_dir("/owned")).status == (
        LookupStatus.EXPIRED
        if parent_state == "expired"
        else LookupStatus.NOT_FOUND
    )

    for _ in range(2):
        if outcome == "error":
            with pytest.raises(RuntimeError, match="unavailable"):
                await entry_or_warm(index, KEY, warm)
        else:
            got = await entry_or_warm(index, KEY, warm)
            assert (got.id if got else None) == (
                "new" if outcome in ("updated", "partial_updated") else None
            )
    assert len(calls) == (
        1 if outcome in ("updated", "renamed", "deleted") else 2
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("parent_state", ["expired", "missing"])
async def test_parallel_parent_refreshes_are_one_transaction(
    orphan_index, parent_state
):
    import asyncio

    index = orphan_index
    rows = [("notes.json", entry_for("old")), ("other.json", entry_for("old"))]
    if parent_state == "expired":
        await index.set_dir("/owned", rows)
        await index.invalidate()
    else:
        for name, entry in rows:
            await index.put(f"/owned/{name}", entry)
    calls = 0

    async def warm():
        nonlocal calls
        calls += 1
        # Let sibling lookups reach the same stale parent while the refresh
        # is in flight, then yield again between publication and the retry.
        await asyncio.sleep(0)
        await index.set_dir(
            "/owned", [(name, entry_for(name)) for name, _ in rows]
        )
        await asyncio.sleep(0)

    keys = ["notes.json", "other.json"] * 4
    found = await asyncio.gather(
        *(entry_or_warm(index, f"/owned/{key}", warm) for key in keys)
    )
    assert [row.id if row else None for row in found] == keys
    assert calls == 1


@pytest.mark.asyncio
async def test_cancelled_parent_waiter_does_not_release_other_waiters():
    import asyncio

    index = RAMIndexCacheStore()
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def warm():
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        await index.set_dir("/owned", [("notes.json", entry_for("new"))])

    first = asyncio.create_task(entry_or_warm(index, KEY, warm))
    await entered.wait()
    cancelled = asyncio.create_task(entry_or_warm(index, KEY, warm))
    follower = asyncio.create_task(entry_or_warm(index, KEY, warm))
    await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    release.set()
    found = await asyncio.gather(first, follower)
    assert [row.id for row in found] == ["new", "new"]
    assert calls == 1


@pytest.mark.asyncio
async def test_parent_refresh_lock_releases_after_failure():
    index = RAMIndexCacheStore()

    async def failed():
        raise RuntimeError("unavailable")

    async def retry():
        await index.set_dir("/owned", [("notes.json", entry_for("new"))])

    with pytest.raises(RuntimeError, match="unavailable"):
        await entry_or_warm(index, KEY, failed)
    assert (await entry_or_warm(index, KEY, retry)).id == "new"


@pytest.mark.asyncio
async def test_partial_refresh_survives_through_its_own_retry():
    import asyncio

    index = RAMIndexCacheStore()
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def warm():
        nonlocal calls
        calls += 1
        await index.put(KEY, entry_for(str(calls)))
        if calls == 1:
            entered.set()
            await release.wait()

    first = asyncio.create_task(entry_or_warm(index, KEY, warm))
    await entered.wait()
    second = asyncio.create_task(entry_or_warm(index, KEY, warm))
    await asyncio.sleep(0)
    release.set()
    found = await asyncio.gather(first, second)
    assert [row.id for row in found] == ["1", "2"]


class _AskedIndex(RAMIndexCacheStore):
    def __init__(self, listed: bool) -> None:
        super().__init__()
        self.listed = listed
        self.asked: list[str] = []

    def listed_this_command(self, folder: str) -> bool:
        self.asked.append(folder)
        return self.listed


async def _absent_listing(index: RAMIndexCacheStore) -> None:
    await index.set_dir("/owned", [("old.json", entry_for("old"))])


async def _expired_listing(index: RAMIndexCacheStore) -> None:
    await index.set_dir(
        "/owned",
        [("old.json", entry_for("old"))],
        expired_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )


async def _partial_listing(index: RAMIndexCacheStore) -> None:
    await index.set_partial_dir("/owned", [("old.json", entry_for("old"))])


async def _no_listing(index: RAMIndexCacheStore) -> None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "listed, setup, found",
    [
        (False, _absent_listing, ListedMiss.UNTRUSTED),
        (True, _absent_listing, None),
        (False, _expired_listing, None),
        (False, _partial_listing, None),
        (False, _no_listing, None),
    ],
    ids=[
        "earlier-listing-lacks-it",
        "this-command-listed-it",
        "expired",
        "partial",
        "no-listing",
    ],
)
async def test_entry_or_listed_miss_flags_only_an_untrusted_complete_miss(
    listed, setup, found
):
    # Only a complete, unexpired listing the running command did not fetch
    # answers UNTRUSTED; with no warm, every other state answers None, as
    # entry_or_warm does. The trust question names the key's folder.
    index = _AskedIndex(listed)
    await setup(index)
    assert await entry_or_listed_miss(index, KEY, None) is found
    assert set(index.asked) <= {"/owned"}

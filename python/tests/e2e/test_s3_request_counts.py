from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from mirage.cache.index.config import IndexConfig
from mirage.types import MountMode, PathSpec, ReadSpec
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session


@contextmanager
def _counted(session: MultiBucketSession) -> Iterator[Counter]:
    client = session._client
    counts = Counter()
    original_head = client.head_object
    original_list = client.list_objects_v2
    original_paginator = client.get_paginator

    async def head(**kwargs):
        counts["head"] += 1
        return await original_head(**kwargs)

    async def listing(**kwargs):
        counts["list"] += 1
        return await original_list(**kwargs)

    def paginator(name):
        result = original_paginator(name)
        original = result.paginate

        async def paginate(**kwargs):
            async for page in original(**kwargs):
                counts["list"] += 1
                yield page

        result.paginate = paginate
        return result

    with (
        patch_s3_session(session),
        patch.object(client, "head_object", head),
        patch.object(client, "list_objects_v2", listing),
        patch.object(client, "get_paginator", paginator),
    ):
        yield counts


def _s3_vfs() -> S3VFS:
    return S3VFS(
        S3Config(
            bucket="bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
    )


@pytest.fixture
def counted_s3():
    session = MultiBucketSession(
        {"bucket": {"a.txt": b"hello", "d/b.txt": b"abc"}}
    )
    with _counted(session) as counts:
        yield Workspace({"/s3": (_s3_vfs(), MountMode.WRITE)}), counts


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        ("cat /s3/a.txt", {"head": 1}),
        ("stat /s3/missing", {"head": 1, "list": 1}),
        ("cp /s3/a.txt /s3/new.txt", {"head": 2, "list": 1}),
        ("mv /s3/a.txt /s3/new.txt", {"head": 3, "list": 1}),
    ],
)
async def test_command_request_counts(counted_s3, command, expected):
    ws, counts = counted_s3
    result = await ws.shell(command)
    await result.stdout_str()
    assert result.exit_code == (1 if "missing" in command else 0)
    assert counts == expected


@pytest.mark.asyncio
async def test_recursive_walks_share_complete_index(counted_s3):
    ws, counts = counted_s3
    cold = await ws.shell("du -a /s3")
    cold_text = await cold.stdout_str()
    counts.clear()
    warm = await ws.shell("du -a /s3")
    assert await warm.stdout_str() == cold_text
    assert counts == {}
    found = await ws.shell("find /s3 -type f")
    assert found.exit_code == 0
    found_text = await found.stdout_str()
    assert "a.txt" in found_text and "b.txt" in found_text
    assert counts == {}


@pytest.mark.asyncio
async def test_writing_an_object_preserves_its_existing_prefix_in_walks():
    objects = {"a/child": b"hello"}
    session = MultiBucketSession({"bucket": objects})
    with patch_s3_session(session):
        ws = Workspace({"/s3": (_s3_vfs(), MountMode.WRITE)})
        try:
            assert await ws.vfs.readdir("/s3") == ["/s3/a"]
            await ws.vfs.write("/s3/a", b"file")
            assert objects == {"a": b"file", "a/child": b"hello"}
            assert await ws.vfs.read("/s3/a/child") == b"hello"
            tree, _ = await ws.dispatch(
                "read_tree", PathSpec.from_str_path("/s3")
            )
            assert tree is None
            for _ in range(2):
                result = await ws.shell("find /s3 -type f")
                assert result.exit_code == 0
                assert await result.stderr_str() == ""
                assert await result.stdout_str() == "/s3/a/child\n"
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_find_warms_du_on_a_non_root_directory(counted_s3):
    ws, counts = counted_s3
    found = await ws.shell("find /s3/d")
    assert found.exit_code == 0
    assert "b.txt" in await found.stdout_str()
    counts.clear()
    first = await ws.shell("du -a /s3/d")
    first_text = await first.stdout_str()
    assert first.exit_code == 0
    assert counts == {}
    counts.clear()
    second = await ws.shell("du -a /s3/d")
    assert await second.stdout_str() == first_text
    assert counts == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("warmup", ["find", "du -a"])
async def test_deleted_recursive_root_is_not_reported_after_expiry(warmup):
    objects = {"d/a.txt": b"old"}
    session = MultiBucketSession({"bucket": objects})
    vfs = S3VFS(
        S3Config(
            bucket="bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
    )
    ws = Workspace({"/s3": (vfs, MountMode.WRITE)})
    with (
        patch_s3_session(session),
        patch("mirage.cache.index.ram.datetime") as clock,
    ):
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        first = await ws.shell(warmup + " /s3/d")
        await first.stdout_str()
        assert first.exit_code == 0
        objects.clear()
        clock.now.return_value += timedelta(seconds=601)
        for command in ["stat", "find"]:
            result = await ws.shell(command + " /s3/d")
            assert await result.stdout_str() == ""
            assert result.exit_code == 1


class _Clock(datetime):
    at: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        return cls.at

    @classmethod
    def advance(cls, seconds: float) -> None:
        cls.at += timedelta(seconds=seconds)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "index_ttl,mount_ttl,steps",
    [
        (86400, 2, [(1, False, 0), (2, True, 1)]),
        (5, 600, [(6, True, 1)]),
    ],
)
async def test_a_listing_lives_as_long_as_the_shorter_of_index_and_mount_ttl(
    monkeypatch, index_ttl, mount_ttl, steps
):
    _Clock.at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for module in ("view", "ram"):
        monkeypatch.setattr(f"mirage.cache.index.{module}.datetime", _Clock)
    objects = {"a.txt": b"hello"}
    with _counted(MultiBucketSession({"bucket": objects})) as counts:
        ws = Workspace(
            {
                "/s3": Mount(
                    vfs=_s3_vfs(),
                    mode=MountMode.WRITE,
                    read=ReadSpec(ttl=mount_ttl),
                )
            },
            index=IndexConfig(ttl=index_ttl),
        )
        try:
            first = await ws.shell("ls /s3")
            assert (first.exit_code, await first.stdout_str()) == (
                0,
                "a.txt\n",
            )
            objects["b.txt"] = b"new"
            for seconds, shown, listed in steps:
                _Clock.advance(seconds)
                before = counts["list"]
                result = await ws.shell("ls /s3")
                assert (result.exit_code, await result.stdout_str()) == (
                    0,
                    "a.txt\nb.txt\n" if shown else "a.txt\n",
                )
                assert counts["list"] - before == listed
        finally:
            await ws.close()

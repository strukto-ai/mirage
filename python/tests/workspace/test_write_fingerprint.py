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
import hashlib
from contextlib import contextmanager

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session

# Non-empty suffix: the mock's ETag is then NOT md5(content), the way a
# multipart or SSE-KMS upload's is not, so a cache entry carrying the
# backend's token is distinguishable from a fabricated md5.
SUFFIX = "-2"


def _etag(data: bytes) -> str:
    return hashlib.md5(data).hexdigest() + SUFFIX


@contextmanager
def _workspace(store: dict[str, bytes], read: ReadSpec):
    """Mount the s3 mock at /s3 and yield the workspace and its client.

    Args:
        store (dict[str, bytes]): initial bucket contents, mutated in
            place so a test can read back what the line wrote.
        read (ReadSpec): the workspace's read policy.
    """
    session = MultiBucketSession({"test-bucket": store}, etag_suffix=SUFFIX)
    with patch_s3_session(session):
        config = S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
        ws = Workspace(
            {"/s3": (S3VFS(config), MountMode.WRITE)},
            mode=MountMode.WRITE,
            read=read,
        )
        yield ws, session._client


def test_write_record_carries_the_backend_token():
    store: dict[str, bytes] = {}
    with _workspace(store,
                    ReadSpec(policy=ReadPolicy.BOUNDED)) as (ws, _client):

        async def run() -> list[tuple[str, str, str | None]]:
            try:
                io = await ws.shell("tee /s3/x.txt", stdin=b"hello\n")
                await io.materialize_stdout()
                return [(r.op, r.path, r.fingerprint)
                        for r in ws.vfs.network_records]
            finally:
                await ws.close()

        records = asyncio.run(run())

    assert records == [("write", "/s3/x.txt", _etag(b"hello\n"))]


def test_written_path_caches_the_backend_token_not_md5():
    """The cache entry for a path mirage wrote must hold what the PUT
    answered. Holding a fabricated md5(content) is only right by accident on a
    simple-PUT object, and never right on a multipart one."""
    store: dict[str, bytes] = {}
    with _workspace(store,
                    ReadSpec(policy=ReadPolicy.BOUNDED)) as (ws, _client):

        async def run() -> tuple[bool, bool]:
            try:
                io = await ws.shell("tee /s3/x.txt", stdin=b"hello\n")
                await io.materialize_stdout()
                md5 = hashlib.md5(b"hello\n").hexdigest()
                return (await ws.cache.is_fresh("/s3/x.txt",
                                                _etag(b"hello\n")), await
                        ws.cache.is_fresh("/s3/x.txt", md5))
            finally:
                await ws.close()

        backend_token, md5_default = asyncio.run(run())

    assert backend_token, "the entry must carry the token the PUT answered"
    # The md5 is now simply one of infinitely many tokens the entry does
    # not carry, rather than the specific wrong answer it used to hold.
    assert not md5_default, "and not a fabricated md5 of the content"


def test_always_reads_a_written_path_from_cache():
    """The cost assertion. With the backend's token on the entry the
    freshness probe matches and the read is served from cache; with no
    token it never matches a suffixed ETag, so every read evicts and
    refetches."""
    store: dict[str, bytes] = {}
    with _workspace(store, ReadSpec(policy=ReadPolicy.FRESH)) as (ws, client):

        async def run() -> bytes:
            try:
                io = await ws.shell("tee /s3/x.txt", stdin=b"hello\n")
                await io.materialize_stdout()
                io2 = await ws.shell("cat /s3/x.txt")
                return await io2.materialize_stdout()
            finally:
                await ws.close()

        served = asyncio.run(run())

    assert served == b"hello\n"
    # Three, not ">= 1": the routing reconcile, cat's own operand stat and
    # the gate's probe. The loose bound was satisfied with the gate fully
    # off, and its TypeScript twin already asserts the exact number.
    assert client.calls["head_object"] == 3, (
        "a `fresh` mount must consult the remote fingerprint on the read")
    assert client.calls["get_object"] == 0, (
        "the written bytes are already cached under the backend's own "
        "token, so the read must not refetch them")


def test_read_then_write_on_one_line_keeps_the_read_token():
    """`IOResult.merge` unions a line's reads and writes, and apply_io
    caches the read's bytes. If those bytes were stamped with the write's
    token the entry would read as fresh forever and the stale bytes would
    serve; the next read must see the written content instead."""
    store = {"f.txt": b"old\n"}
    with _workspace(store, ReadSpec(policy=ReadPolicy.FRESH)) as (ws, _client):

        async def run() -> bytes:
            try:
                io = await ws.shell("cat /s3/f.txt && echo new | tee /s3/f.txt"
                                    )
                await io.materialize_stdout()
                io2 = await ws.shell("cat /s3/f.txt")
                return await io2.materialize_stdout()
            finally:
                await ws.close()

        served = asyncio.run(run())

    assert store["f.txt"] == b"new\n"
    assert served == b"new\n", (
        "the cache served pre-write bytes under the post-write token")


def test_write_then_truncate_on_one_line_does_not_pin_stale_bytes():
    """`truncate` records its own token but hands the cache no bytes, so
    the entry would otherwise hold tee's content under truncate's token
    and serve it for the life of the entry."""
    store: dict[str, bytes] = {}
    with _workspace(store, ReadSpec(policy=ReadPolicy.FRESH)) as (ws, _client):

        async def run() -> bytes:
            try:
                io = await ws.shell(
                    "echo hello | tee /s3/f.txt && truncate -s 2 /s3/f.txt")
                await io.materialize_stdout()
                io2 = await ws.shell("cat /s3/f.txt")
                return await io2.materialize_stdout()
            finally:
                await ws.close()

        served = asyncio.run(run())

    assert store["f.txt"] == b"he"
    assert served == b"he"


def test_write_then_copy_over_it_does_not_pin_stale_bytes():
    """`cp` replaces the path's entry in `IOResult.writes` with an empty
    eviction marker while tee's write record stays the last one, so the
    token would land on bytes it does not describe."""
    store = {"a.txt": b"x\n"}
    with _workspace(store, ReadSpec(policy=ReadPolicy.FRESH)) as (ws, _client):

        async def run() -> bytes:
            try:
                io = await ws.shell(
                    "echo x | tee /s3/f.txt && cp /s3/a.txt /s3/f.txt")
                await io.materialize_stdout()
                io2 = await ws.shell("cat /s3/f.txt")
                return await io2.materialize_stdout()
            finally:
                await ws.close()

        served = asyncio.run(run())

    assert store["f.txt"] == b"x\n"
    assert served == b"x\n"

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
import time

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import ConsistencyPolicy, MountMode
from mirage.workspace import Workspace
from tests.integration.s3_mock import MultiBucketSession, patch_s3_session


def test_disk_always_refetches_after_external_mutation(tmp_path):
    root = tmp_path / "disk"
    root.mkdir()
    (root / "file.txt").write_bytes(b"v1")

    resource = DiskResource(root=str(root))
    ws = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )

    async def run() -> tuple[bytes, bytes]:
        io1 = await ws.execute("cat /data/file.txt")
        first = await io1.materialize_stdout()
        time.sleep(1.1)
        (root / "file.txt").write_bytes(b"v2")
        io2 = await ws.execute("cat /data/file.txt")
        second = await io2.materialize_stdout()
        return first, second

    first, second = asyncio.run(run())
    assert first == b"v1"
    assert second == b"v2", (
        "ALWAYS must refetch from disk after mtime changed; got stale cache")


def test_disk_lazy_keeps_stale_cache_after_external_mutation(tmp_path):
    root = tmp_path / "disk"
    root.mkdir()
    (root / "file.txt").write_bytes(b"v1")

    resource = DiskResource(root=str(root))
    ws = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.LAZY,
    )

    async def run() -> tuple[bytes, bytes]:
        io1 = await ws.execute("cat /data/file.txt")
        first = await io1.materialize_stdout()
        time.sleep(1.1)
        (root / "file.txt").write_bytes(b"v2")
        io2 = await ws.execute("cat /data/file.txt")
        second = await io2.materialize_stdout()
        return first, second

    first, second = asyncio.run(run())
    assert first == b"v1"
    assert second in (b"v1", b"v2"), (
        "LAZY allowed to serve cached bytes; this test just confirms no crash")


def test_s3_always_warm_read_serves_cache_for_non_md5_fingerprint():
    """Multipart-style ETags are not the MD5 of the content. The cold
    read must stamp the cache entry with the backend ETag so a warm read
    under ALWAYS passes the freshness check and serves from cache
    instead of evicting and refetching on every read."""
    store = {"data.txt": b"name,age\nalice,30\n"}
    session = MultiBucketSession({"test-bucket": store}, etag_suffix="-2")
    client = session._client
    with patch_s3_session(session):
        config = S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
        ws = Workspace(
            {"/s3": (S3Resource(config), MountMode.WRITE)},
            mode=MountMode.WRITE,
            consistency=ConsistencyPolicy.ALWAYS,
        )

        async def run() -> tuple[bytes, bytes]:
            io1 = await ws.execute("cat /s3/data.txt | wc -c")
            first = await io1.materialize_stdout()
            io2 = await ws.execute("cat /s3/data.txt | wc -c")
            second = await io2.materialize_stdout()
            return first, second

        first, second = asyncio.run(run())
    assert first == second == b"18\n"
    assert client.calls["head_object"] >= 1, (
        "ALWAYS must consult the remote fingerprint on the warm read")
    assert client.calls["get_object"] == 1, (
        "warm read with an unchanged remote fingerprint must serve from "
        "cache; a second get_object means the entry was evicted")


def test_ram_falls_back_to_lazy_when_fingerprint_absent():
    resource = RAMResource()
    resource._store.files["/file.txt"] = b"v1"
    ws = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )

    async def run() -> bytes:
        io1 = await ws.execute("cat /data/file.txt")
        return await io1.materialize_stdout()

    data = asyncio.run(run())
    assert data == b"v1", (
        "RAM read under ALWAYS must succeed (no fingerprint → LAZY fallback)")

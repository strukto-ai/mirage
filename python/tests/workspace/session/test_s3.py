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
import json

import pytest

from mirage.accessor.s3 import S3Config
from mirage.workspace.session.s3 import S3SessionStore
from tests.workspace.s3_fake import FakeConditionalS3Client, patch_record_s3

BUCKET = "state-bucket"


def _config() -> S3Config:
    return S3Config(bucket=BUCKET,
                    region="us-east-1",
                    aws_access_key_id="fake",
                    aws_secret_access_key="fake",
                    key_prefix="mirage/ws1/")


async def cas_increment(store: S3SessionStore, worker: str,
                        rounds: int) -> None:
    """Read-modify-CAS one counter, retrying until each round lands."""
    for _ in range(rounds):
        for _ in range(200):
            record = (await store.load()).get("hot", {
                "session_id": "hot",
                "env": {},
            })
            env = dict(record.get("env", {}))
            env[worker] = str(int(env.get(worker, "0")) + 1)
            expected = int(record.get("generation", 0))
            fields = dict(record)
            fields["env"] = env
            fields["generation"] = expected + 1
            if await store.cas_set("hot", fields, expected):
                break
            await asyncio.sleep(0)
        else:
            raise AssertionError("cas retry budget exhausted")


@pytest.mark.asyncio
async def test_set_load_roundtrip():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        await store.set("s1", {"session_id": "s1", "cwd": "/a", "env": {}})
        await store.set(
            "s2", {
                "session_id": "s2",
                "cwd": "/",
                "env": {
                    "K": "v"
                },
                "mount_modes": {
                    "/data": "read"
                }
            })
        entries = await store.load()
        await store.close()
    assert entries["s1"]["cwd"] == "/a"
    assert entries["s2"]["mount_modes"] == {"/data": "read"}
    assert (BUCKET, "mirage/ws1/sessions/s1.json") in client.objects


@pytest.mark.asyncio
async def test_delete_and_replace_all():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        await store.set("a", {"session_id": "a"})
        await store.set("b", {"session_id": "b"})
        await store.delete(["a", "missing"])
        assert set(await store.load()) == {"b"}
        await store.replace_all({"c": {"session_id": "c"}})
        assert set(await store.load()) == {"c"}
        await store.clear()
        assert await store.load() == {}
        await store.close()


@pytest.mark.asyncio
async def test_cas_create_only_once():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        first = {"session_id": "s", "generation": 1}
        assert await store.cas_set("s", first, 0) is True
        assert await store.cas_set("s", {
            "session_id": "s",
            "generation": 1
        }, 0) is False
        await store.close()
    stored = json.loads(client.objects[(BUCKET, "mirage/ws1/sessions/s.json")])
    assert stored == first


@pytest.mark.asyncio
async def test_cas_stale_generation_rejected():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        await store.set("s", {"session_id": "s", "generation": 2})
        assert await store.cas_set("s", {
            "session_id": "s",
            "generation": 2
        }, 1) is False
        assert await store.cas_set("s", {
            "session_id": "s",
            "cwd": "/x",
            "generation": 3
        }, 2) is True
        entries = await store.load()
        await store.close()
    assert entries["s"]["cwd"] == "/x"


@pytest.mark.asyncio
async def test_cas_legacy_record_counts_as_generation_zero():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        await store.set("s", {"session_id": "s"})
        assert await store.cas_set("s", {
            "session_id": "s",
            "generation": 1
        }, 0) is True
        await store.close()


class RaceOnceClient(FakeConditionalS3Client):
    """Move the stored record between a CAS's compare-read and its
    conditional write, exactly once."""

    def __init__(self) -> None:
        super().__init__()
        self.raced = False

    async def get_object(self, Bucket: str, Key: str) -> dict:
        response = await super().get_object(Bucket, Key)
        if not self.raced:
            self.raced = True
            self.objects[(Bucket, Key)] = json.dumps({
                "session_id": "s",
                "cwd": "/winner",
                "generation": 2
            }).encode()
        return response


@pytest.mark.asyncio
async def test_cas_write_race_detected_by_conditional_put():
    client = RaceOnceClient()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        await store.set("s", {"session_id": "s", "generation": 1})
        client.raced = False
        assert await store.cas_set("s", {
            "session_id": "s",
            "cwd": "/loser",
            "generation": 2
        }, 1) is False
        entries = await store.load()
        await store.close()
    assert entries["s"]["cwd"] == "/winner"


@pytest.mark.asyncio
async def test_concurrent_cas_writers_lose_nothing():
    client = FakeConditionalS3Client()
    with patch_record_s3(client):
        store = S3SessionStore(_config())
        workers = [f"w{i}" for i in range(5)]
        await asyncio.gather(*(cas_increment(store, worker, 5)
                               for worker in workers))
        record = (await store.load())["hot"]
        await store.close()
    assert record["generation"] == 25
    assert all(record["env"][worker] == "5" for worker in workers)

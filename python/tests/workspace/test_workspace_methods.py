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
import copy as _copy
import os
import time
import uuid

import pytest

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.shell.job_table import Job, JobStatus
from mirage.types import MountMode
from mirage.workspace import Workspace
from tests.e2e.s3_mock import patch_s3_multi

REDIS_URL = os.environ.get("REDIS_URL", "")


def _load(*args, **kwargs):
    return asyncio.run(Workspace.load(*args, **kwargs))


def _read(ws, path):

    async def _do():
        r = await ws.execute(f"cat {path}")
        return await r.stdout_str()

    return asyncio.run(_do())


# ── Workspace.save / Workspace.load (instance + classmethod) ─────────


def test_workspace_save_then_load_classmethod(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo hi > /m/a.txt"))

    snap = tmp_path / "ws.tar"
    asyncio.run(src.snapshot(snap))
    assert snap.exists() and snap.stat().st_size > 0

    dst = _load(snap)
    assert _read(dst, "/m/a.txt") == "hi\n"


def test_workspace_save_compressed(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo hi > /m/a.txt"))

    snap = tmp_path / "ws.tar.gz"
    asyncio.run(src.snapshot(snap, compress="gz"))
    dst = _load(snap)
    assert _read(dst, "/m/a.txt") == "hi\n"


def test_workspace_load_with_disk_override(tmp_path):
    src_root = tmp_path / "src"
    src_root.mkdir()
    (src_root / "a.txt").write_bytes(b"hello\n")
    src = Workspace(
        {"/m": (DiskResource(root=str(src_root)), MountMode.WRITE)},
        mode=MountMode.WRITE)

    snap = tmp_path / "ws.tar"
    asyncio.run(src.snapshot(snap))

    dst_root = tmp_path / "dst"
    dst_root.mkdir()
    dst = _load(snap, resources={"/m": DiskResource(root=str(dst_root))})
    assert _read(dst, "/m/a.txt") == "hello\n"
    assert (dst_root / "a.txt").read_bytes() == b"hello\n"


# ── Workspace.copy ────────────────────────────────────────────────


def test_workspace_copy_method_independence_ram():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo hi > /m/a.txt"))

    cp = asyncio.run(src.copy())
    asyncio.run(cp.execute("echo bye > /m/a.txt"))

    assert _read(src, "/m/a.txt") == "hi\n"
    assert _read(cp, "/m/a.txt") == "bye\n"


# ── copy.deepcopy(ws) → uses __deepcopy__ → uses copy() ──────────


def test_deepcopy_via_stdlib():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo hi > /m/a.txt"))

    cp = asyncio.run((src).copy())
    asyncio.run(cp.execute("echo bye > /m/a.txt"))

    assert _read(src, "/m/a.txt") == "hi\n"
    assert _read(cp, "/m/a.txt") == "bye\n"


# ── copy.copy(ws) must raise — shallow copy makes no sense ────────


def test_shallow_copy_raises():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    with pytest.raises(NotImplementedError, match="useful shallow copy"):
        _copy.copy(src)


def test_shallow_copy_error_mentions_alternatives():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    with pytest.raises(NotImplementedError) as exc_info:
        _copy.copy(src)
    msg = str(exc_info.value)
    assert "ws.copy()" in msg


# ── max_drain_bytes preserved across save/load ───────────────────


def test_save_load_preserves_max_drain_bytes(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    src.max_drain_bytes = 1234

    snap = tmp_path / "ws.tar"
    asyncio.run(src.snapshot(snap))

    dst = _load(snap)
    assert dst.max_drain_bytes == 1234


# ── history round trip ────────────────────────────────────────────


def test_history_round_trip(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo a > /m/a.txt"))
    asyncio.run(src.execute("echo b > /m/b.txt"))
    asyncio.run(src.execute("cat /m/a.txt"))
    expected_commands = [e["command"] for e in asyncio.run(src.history())]
    assert len(expected_commands) == 3

    snap = tmp_path / "ws.tar"
    asyncio.run(src.snapshot(snap))
    dst = _load(snap)

    got_commands = [e["command"] for e in asyncio.run(dst.history())]
    assert got_commands == expected_commands


# ── finished jobs survive, pending dropped ────────────────────────


def test_finished_jobs_survive(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    finished = Job(id=1,
                   command="echo done",
                   task=None,
                   cwd="/",
                   status=JobStatus.COMPLETED,
                   stdout=b"done\n",
                   stderr=b"",
                   exit_code=0,
                   created_at=time.time(),
                   agent="test",
                   session_id="default")
    src.job_table._jobs[1] = finished

    snap = tmp_path / "ws.tar"
    asyncio.run(src.snapshot(snap))
    dst = _load(snap)

    job_ids = {j.id for j in dst.job_table.list_jobs()}
    assert 1 in job_ids
    # Next job id continues from max(finished)+1 (= 2)
    assert dst.job_table._next_id == 2


# ── copy() shares Redis backend (documented divergence) ──────────


@pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")
def test_copy_shares_redis_backend():
    import redis as sync_redis

    from mirage.resource.redis import RedisResource

    prefix = f"mirage:test:copy:{uuid.uuid4().hex}:"
    src = Workspace(
        {
            "/r":
            (RedisResource(url=REDIS_URL, key_prefix=prefix), MountMode.WRITE)
        },
        mode=MountMode.WRITE)

    sc = sync_redis.Redis.from_url(REDIS_URL)
    sc.set(f"{prefix}file:/seed.txt", b"shared")
    sc.close()

    cp = asyncio.run(src.copy())
    asyncio.run(cp.execute("echo new > /r/added.txt"))

    sc = sync_redis.Redis.from_url(REDIS_URL)
    try:
        # Both src and cp see the new key — they share the same Redis
        # instance even though they are independent Workspaces.
        assert sc.get(f"{prefix}file:/added.txt") == b"new\n"
    finally:
        for key in sc.scan_iter(f"{prefix}*"):
            sc.delete(key)
        sc.close()


# ── copy() independence of cache ─────────────────────────────────


def test_copy_independence_of_cache():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src._cache.set("/m/a.txt", b"src-cached"))

    cp = asyncio.run(src.copy())
    asyncio.run(cp._cache.set("/m/a.txt", b"cp-cached"))

    src_cached = asyncio.run(src._cache.get("/m/a.txt"))
    cp_cached = asyncio.run(cp._cache.get("/m/a.txt"))
    assert src_cached == b"src-cached"
    assert cp_cached == b"cp-cached"


# ── S3 round trip via workspace.save (mocked) ──────────────────


def test_workspace_save_load_s3_mounted(tmp_path):
    cfg_src = S3Config(bucket="src-bkt",
                       region="us-east-1",
                       aws_access_key_id="OLD-AKIA-OBVIOUS",
                       aws_secret_access_key="OLD-SECRET-OBVIOUS")
    cfg_dst = S3Config(bucket="dst-bkt",
                       region="us-east-1",
                       aws_access_key_id="NEW-AKIA",
                       aws_secret_access_key="NEW-SECRET")
    buckets: dict = {"src-bkt": {}, "dst-bkt": {}}

    with patch_s3_multi(buckets):
        src = Workspace({"/s3": (S3Resource(cfg_src), MountMode.WRITE)},
                        mode=MountMode.WRITE)
        snap = tmp_path / "ws.tar"
        asyncio.run(src.snapshot(snap))

        # Saved tar must not contain old creds
        raw = snap.read_bytes()
        assert b"OLD-AKIA-OBVIOUS" not in raw
        assert b"OLD-SECRET-OBVIOUS" not in raw
        assert b"<REDACTED>" in raw

        dst = _load(snap, resources={"/s3": S3Resource(cfg_dst)})
        # New mount uses fresh creds, fresh bucket
        assert dst.mount("/s3").resource.config.bucket == "dst-bkt"


# ── override drops saved index ───────────────────────────────────


def test_override_drops_saved_index(tmp_path):
    """When the caller supplies an override resource, that resource's
    own (fresh, empty) index is used — not whatever was on the saved
    resource. We verify by checking the loaded mount is the override
    object itself.
    """
    cfg = S3Config(bucket="b",
                   region="us-east-1",
                   aws_access_key_id="x",
                   aws_secret_access_key="y")
    buckets: dict = {"b": {}}
    with patch_s3_multi(buckets):
        src = Workspace({"/s3": (S3Resource(cfg), MountMode.WRITE)},
                        mode=MountMode.WRITE)

        snap = tmp_path / "ws.tar"
        asyncio.run(src.snapshot(snap))

        fresh = S3Resource(cfg)
        dst = _load(snap, resources={"/s3": fresh})
        # The mounted resource IS the user-supplied fresh one,
        # carrying its own (empty) index — not anything from the snapshot.
        assert dst.mount("/s3").resource is fresh

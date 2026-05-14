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
import tarfile

import pytest

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.snapshot import to_state_dict


def _seed(ws, mount: str = "/m") -> None:

    async def _do():
        await ws.execute(f"echo hello > {mount}/a.txt")
        await ws.execute(
            f"mkdir -p {mount}/sub && echo world > {mount}/sub/b.txt")

    asyncio.run(_do())


def _read(ws, path: str) -> str:

    async def _do():
        r = await ws.execute(f"cat {path}")
        return await r.stdout_str()

    return asyncio.run(_do())


# ── RAM round trip ──────────────────────────────────────────────────


def test_save_load_ram_round_trip(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    _seed(src)
    snap = tmp_path / "ram.tar"
    asyncio.run(src.snapshot(snap))
    assert snap.exists() and snap.stat().st_size > 0

    dst = Workspace.load(snap)
    assert _read(dst, "/m/a.txt") == "hello\n"
    assert _read(dst, "/m/sub/b.txt") == "world\n"


def test_save_load_ram_compressed_gz(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    _seed(src)
    snap = tmp_path / "ram.tar.gz"
    asyncio.run(src.snapshot(snap, compress="gz"))

    dst = Workspace.load(snap)
    assert _read(dst, "/m/a.txt") == "hello\n"


# ── Disk round trip ────────────────────────────────────────────────


def test_save_load_disk_round_trip(tmp_path):
    src_root = tmp_path / "src"
    src_root.mkdir()
    src = Workspace(
        {"/m": (DiskResource(root=str(src_root)), MountMode.WRITE)},
        mode=MountMode.WRITE)
    _seed(src)
    snap = tmp_path / "disk.tar"
    asyncio.run(src.snapshot(snap))

    dst = Workspace.load(snap)
    assert _read(dst, "/m/a.txt") == "hello\n"
    assert _read(dst, "/m/sub/b.txt") == "world\n"


def test_save_load_disk_with_override_root(tmp_path):
    src_root = tmp_path / "src"
    src_root.mkdir()
    src = Workspace(
        {"/m": (DiskResource(root=str(src_root)), MountMode.WRITE)},
        mode=MountMode.WRITE)
    _seed(src)
    snap = tmp_path / "disk.tar"
    asyncio.run(src.snapshot(snap))

    dst_root = tmp_path / "dst"
    dst_root.mkdir()
    dst = Workspace.load(snap,
                         resources={"/m": DiskResource(root=str(dst_root))})
    assert (dst_root / "a.txt").read_bytes() == b"hello\n"
    assert (dst_root / "sub" / "b.txt").read_bytes() == b"world\n"
    assert _read(dst, "/m/a.txt") == "hello\n"


# ── needs_override enforcement ──────────────────────────────────────


def test_needs_override_missing_raises(tmp_path):
    cfg = S3Config(bucket="b",
                   region="us-east-1",
                   aws_access_key_id="AKIA-LEAK",
                   aws_secret_access_key="SECRET-LEAK")
    src = Workspace({"/s3": (S3Resource(cfg), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    snap = tmp_path / "s3.tar"
    asyncio.run(src.snapshot(snap))

    with pytest.raises(ValueError, match=r"resources="):
        Workspace.load(snap)


def test_needs_override_lists_all_missing(tmp_path):
    src = Workspace(
        {
            "/ram": (RAMResource(), MountMode.WRITE),
            "/s3a": (S3Resource(
                S3Config(bucket="a",
                         region="us-east-1",
                         aws_access_key_id="x",
                         aws_secret_access_key="x")), MountMode.WRITE),
            "/s3b": (S3Resource(
                S3Config(bucket="b",
                         region="us-east-1",
                         aws_access_key_id="x",
                         aws_secret_access_key="x")), MountMode.WRITE),
        },
        mode=MountMode.WRITE)
    snap = tmp_path / "two-s3.tar"
    asyncio.run(src.snapshot(snap))

    with pytest.raises(ValueError) as ei:
        Workspace.load(snap)
    msg = str(ei.value)
    assert "/s3a" in msg
    assert "/s3b" in msg


# ── cred redaction in raw bytes ─────────────────────────────────────


def test_no_real_creds_in_tar_bytes(tmp_path):
    cfg = S3Config(bucket="b",
                   region="us-east-1",
                   aws_access_key_id="AKIA-OBVIOUS-LEAK",
                   aws_secret_access_key="SECRET-OBVIOUS-LEAK")
    src = Workspace({"/s3": (S3Resource(cfg), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    snap = tmp_path / "s3.tar"
    asyncio.run(src.snapshot(snap))

    raw = snap.read_bytes()
    assert b"AKIA-OBVIOUS-LEAK" not in raw
    assert b"SECRET-OBVIOUS-LEAK" not in raw
    assert b"<REDACTED>" in raw


# ── manifest validity ──────────────────────────────────────────────


def test_manifest_is_valid_json(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    _seed(src)
    snap = tmp_path / "snap.tar"
    asyncio.run(src.snapshot(snap))

    with tarfile.open(snap, "r") as tar:
        f = tar.extractfile("manifest.json")
        manifest = json.loads(f.read().decode("utf-8"))
    assert manifest["version"] == 2
    assert "mounts" in manifest
    assert "cache" in manifest


def test_disk_files_extractable_from_tar(tmp_path):
    src_root = tmp_path / "src"
    src_root.mkdir()
    src = Workspace(
        {"/m": (DiskResource(root=str(src_root)), MountMode.WRITE)},
        mode=MountMode.WRITE)
    _seed(src)
    snap = tmp_path / "disk.tar"
    asyncio.run(src.snapshot(snap))

    extract = tmp_path / "extract"
    extract.mkdir()
    with tarfile.open(snap, "r") as tar:
        for member in tar.getmembers():
            if member.name.startswith("mounts/0/files/"):
                tar.extract(member, extract, filter="data")
    assert (extract / "mounts/0/files/a.txt").read_bytes() == b"hello\n"
    assert (extract / "mounts/0/files/sub/b.txt").read_bytes() == b"world\n"


# ── path-traversal defense ─────────────────────────────────────────


def test_load_rejects_path_traversal_in_blob_ref(tmp_path):
    snap = tmp_path / "bad.tar"
    manifest = {
        "version":
        1,
        "mirage_version":
        "0.1.0",
        "default_session_id":
        "default",
        "default_agent_id":
        "default",
        "current_agent_id":
        "default",
        "sessions": [],
        "history":
        None,
        "mounts": [{
            "index": 0,
            "prefix": "/m",
            "mode": "WRITE",
            "consistency": "LAZY",
            "resource_class": "mirage.resource.ram.RAMResource",
            "resource_state": {
                "type": "ram",
                "needs_override": False,
                "redacted_fields": [],
                "files": {
                    "/x": {
                        "__file": "../../etc/passwd"
                    }
                },
                "dirs": [],
                "modified": {},
            },
        }],
        "cache": {
            "limit": 0,
            "max_drain_bytes": None,
            "entries": []
        },
        "jobs": [],
    }
    with tarfile.open(snap, "w") as tar:
        data = json.dumps(manifest).encode("utf-8")
        info = tarfile.TarInfo(name="manifest.json")
        info.size = len(data)
        import io as _io
        tar.addfile(info, _io.BytesIO(data))

    with pytest.raises(ValueError, match="Unsafe blob path"):
        Workspace.load(snap)


# ── copy ───────────────────────────────────────────────────────────


def test_workspace_copy_independence_ram():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    asyncio.run(src.execute("echo hi > /m/a.txt"))

    cp = asyncio.run(src.copy())
    asyncio.run(cp.execute("echo bye > /m/a.txt"))

    assert _read(src, "/m/a.txt") == "hi\n"
    assert _read(cp, "/m/a.txt") == "bye\n"


def test_workspace_copy_preserves_max_drain_bytes():
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    src.max_drain_bytes = 1234
    cp = asyncio.run(src.copy())
    assert cp.max_drain_bytes == 1234


# ── state dict shape ───────────────────────────────────────────────


def test_to_state_dict_shape():
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    state = to_state_dict(ws)
    assert state["version"] == 2
    assert "mirage_version" in state
    assert isinstance(state["mounts"], list)
    assert state["cache"]["entries"] == []
    assert state["jobs"] == []


def test_snapshot_round_trip_no_sync_policy(tmp_path):
    ws = Workspace({"/data": RAMResource()})
    target = tmp_path / "snap.tar"
    asyncio.run(ws.snapshot(str(target)))
    restored = Workspace.load(str(target))
    assert restored is not None


# ── filenames with spaces / unicode ───────────────────────────────


def test_ram_round_trip_filenames_with_spaces(tmp_path):
    src = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                    mode=MountMode.WRITE)
    src._registry.mount_for("/m/").resource._store.files["/my file.txt"] = (
        b"with spaces")
    src._registry.mount_for("/m/").resource._store.files[
        "/dir with space/data.txt"] = b"nested with space"
    src._registry.mount_for("/m/").resource._store.files["/数据.txt"] = (
        "你好".encode())

    snap = tmp_path / "spaces.tar"
    asyncio.run(src.snapshot(snap))
    dst = Workspace.load(snap)

    files = dst._registry.mount_for("/m/").resource._store.files
    assert files["/my file.txt"] == b"with spaces"
    assert files["/dir with space/data.txt"] == b"nested with space"
    assert files["/数据.txt"].decode() == "你好"


def test_disk_round_trip_filenames_with_spaces(tmp_path):
    src_root = tmp_path / "src"
    src_root.mkdir()
    (src_root / "my file.txt").write_bytes(b"hello space")
    (src_root / "dir with space").mkdir()
    (src_root / "dir with space" / "data.txt").write_bytes(b"deep space")
    (src_root / "数据.txt").write_bytes("你好".encode())

    src = Workspace(
        {"/m": (DiskResource(root=str(src_root)), MountMode.WRITE)},
        mode=MountMode.WRITE)
    snap = tmp_path / "disk-spaces.tar"
    asyncio.run(src.snapshot(snap))

    dst_root = tmp_path / "dst"
    dst_root.mkdir()
    Workspace.load(snap, resources={"/m": DiskResource(root=str(dst_root))})
    assert (dst_root / "my file.txt").read_bytes() == b"hello space"
    assert ((dst_root / "dir with space" /
             "data.txt").read_bytes() == b"deep space")
    assert (dst_root / "数据.txt").read_bytes().decode() == "你好"


def test_is_safe_blob_path_allows_spaces_and_unicode():
    from mirage.workspace.snapshot import is_safe_blob_path
    assert is_safe_blob_path("my file.txt")
    assert is_safe_blob_path("dir with space/data.txt")
    assert is_safe_blob_path("数据.txt")
    assert not is_safe_blob_path("../etc/passwd")
    assert not is_safe_blob_path("/abs/path")
    assert not is_safe_blob_path("")
    assert not is_safe_blob_path("foo/../bar")
    assert not is_safe_blob_path("foo\x00bar")


# ── Redis round trip ───────────────────────────────────────────────


@pytest.mark.skipif(not __import__("os").environ.get("REDIS_URL"),
                    reason="REDIS_URL not set")
def test_redis_round_trip_filenames_with_spaces(tmp_path):
    import os
    import uuid

    import redis as sync_redis

    from mirage.resource.redis import RedisResource
    redis_url = os.environ["REDIS_URL"]
    src_prefix = f"mirage:test:src:{uuid.uuid4().hex}:"
    dst_prefix = f"mirage:test:dst:{uuid.uuid4().hex}:"

    sc = sync_redis.Redis.from_url(redis_url)
    sc.set(f"{src_prefix}file:/my file.txt", b"hello space")
    sc.set(f"{src_prefix}file:/dir with space/data.txt", b"deep space")
    sc.sadd(f"{src_prefix}dir", "/dir with space")
    sc.close()

    src = Workspace(
        {
            "/m": (RedisResource(url=redis_url,
                                 key_prefix=src_prefix), MountMode.WRITE)
        },
        mode=MountMode.WRITE)
    snap = tmp_path / "redis-spaces.tar"
    asyncio.run(src.snapshot(snap))

    dst_resource = RedisResource(url=redis_url, key_prefix=dst_prefix)
    Workspace.load(snap, resources={"/m": dst_resource})

    sc = sync_redis.Redis.from_url(redis_url)
    try:
        assert sc.get(f"{dst_prefix}file:/my file.txt") == b"hello space"
        assert (sc.get(f"{dst_prefix}file:/dir with space/data.txt") ==
                b"deep space")
    finally:
        for prefix in (src_prefix, dst_prefix):
            for key in sc.scan_iter(f"{prefix}*"):
                sc.delete(key)
        sc.close()

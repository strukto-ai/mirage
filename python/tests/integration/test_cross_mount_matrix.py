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
import uuid
from contextlib import ExitStack

import pytest

from mirage.core.ram.mkdir import mkdir as mem_mkdir
from mirage.core.ram.write import write_bytes as mem_write
from mirage.core.redis.mkdir import mkdir as redis_mkdir
from mirage.core.redis.write import write_bytes as redis_write
from mirage.resource.disk import DiskResource
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import DEFAULT_SESSION_ID, MountMode, PathSpec
from mirage.workspace import Workspace
from tests.integration.gdrive_mock import FakeGDrive, patch_gdrive
from tests.integration.s3_mock import patch_s3_multi

REDIS_URL = os.environ.get("REDIS_URL", "")

WRITABLE = {"ram", "disk", "redis", "s3"}

_PAIRS = [
    ("ram", "s3"),
    ("s3", "ram"),
    ("disk", "s3"),
    ("s3", "disk"),
    ("redis", "s3"),
    ("s3", "redis"),
    ("s3", "s3"),
    ("ram", "gdrive"),
    ("gdrive", "ram"),
    ("disk", "gdrive"),
    ("gdrive", "disk"),
    ("redis", "gdrive"),
    ("gdrive", "redis"),
    ("gdrive", "gdrive"),
]


def _supports_write(ptype: str) -> bool:
    return ptype in WRITABLE


def _supports_delete(ptype: str) -> bool:
    return ptype in WRITABLE


def _make_s3_resource(bucket: str) -> S3Resource:
    config = S3Config(bucket=bucket,
                      region="us-east-1",
                      aws_access_key_id="testing",
                      aws_secret_access_key="testing")
    return S3Resource(config)


def _make_redis_resource(prefix: str) -> RedisResource:
    return RedisResource(url=REDIS_URL, key_prefix=prefix)


def _make_gdrive_resource() -> GoogleDriveResource:
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    return GoogleDriveResource(config)


class _MountState:

    def __init__(self, ptype: str, mount_path: str, idx: int) -> None:
        self.ptype = ptype
        self.mount_path = mount_path
        self.idx = idx
        self.disk_root = None
        self.s3_bucket: str | None = None
        self.gdrive: FakeGDrive | None = None
        self.redis_prefix: str | None = None
        self.resource = None
        self.accessor = None


def _build_mount(ptype: str, mount_path: str, tmp_path,
                 idx: int) -> _MountState:
    state = _MountState(ptype, mount_path, idx)
    if ptype == "ram":
        state.resource = RAMResource()
        state.accessor = state.resource.accessor
    elif ptype == "disk":
        root = tmp_path / f"disk{idx}"
        root.mkdir()
        state.disk_root = root
        state.resource = DiskResource(root=str(root))
    elif ptype == "redis":
        prefix = f"mirage:test:{uuid.uuid4().hex}:{idx}:"
        state.redis_prefix = prefix
        state.resource = _make_redis_resource(prefix)
    elif ptype == "s3":
        state.s3_bucket = f"test-bucket-{idx}"
        state.resource = _make_s3_resource(state.s3_bucket)
    elif ptype == "gdrive":
        state.gdrive = FakeGDrive()
        state.resource = _make_gdrive_resource()
    else:
        raise ValueError(f"unknown resource: {ptype}")
    return state


async def _populate_file_async(state: _MountState, name: str,
                               content: bytes) -> None:
    if state.ptype == "ram":
        parts = ("/" + name).strip("/").split("/")
        for i in range(1, len(parts)):
            d = "/" + "/".join(parts[:i])
            if d not in state.accessor.store.dirs:
                try:
                    await mem_mkdir(state.accessor, d)
                except (FileExistsError, ValueError):
                    pass
        await mem_write(state.accessor, PathSpec.from_str_path("/" + name),
                        content)
    elif state.ptype == "disk":
        full = state.disk_root / name
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(content)
    elif state.ptype == "redis":
        parts = ("/" + name).strip("/").split("/")
        for i in range(1, len(parts)):
            d = "/" + "/".join(parts[:i])
            try:
                await redis_mkdir(state.resource.accessor, d)
            except (FileExistsError, ValueError):
                pass
        await redis_write(state.resource.accessor,
                          PathSpec.from_str_path("/" + name), content)


def _populate_file(state: _MountState, name: str, content: bytes,
                   buckets: dict) -> None:
    if state.ptype in ("ram", "disk", "redis"):
        asyncio.run(_populate_file_async(state, name, content))
    elif state.ptype == "s3":
        buckets.setdefault(state.s3_bucket, {})[name] = content
    elif state.ptype == "gdrive":
        state.gdrive.add_file(name, content)


async def _ls_for_index(ws: Workspace, state: "_MountState",
                        name: str) -> None:
    mount_path = state.mount_path
    parts = name.strip("/").split("/")
    for i in range(len(parts)):
        sub = "/".join(parts[:i])
        path = f"{mount_path}/{sub}".rstrip("/") or mount_path
        # Files are seeded straight into the backend, bypassing the mirage
        # write path that would normally invalidate the parent listing, so a
        # previously warmed (now stale) index entry must be dropped before the
        # ls re-lists it.
        await state.resource.index.invalidate_dir(path)
        await ws.execute(f"ls {path}")


class CrossMountEnv:

    def __init__(self, ws: Workspace, m1: _MountState, m2: _MountState,
                 buckets: dict) -> None:
        self.ws = ws
        self.m1 = m1
        self.m2 = m2
        self.buckets = buckets

    @property
    def src_type(self) -> str:
        return self.m1.ptype

    @property
    def dst_type(self) -> str:
        return self.m2.ptype

    def create_file(self, mount_idx: int, name: str, content: bytes) -> None:
        state = self.m1 if mount_idx == 1 else self.m2
        _populate_file(state, name, content, self.buckets)
        if state.ptype == "gdrive":
            asyncio.run(_ls_for_index(self.ws, state, name))

    def run(self, cmd: str) -> str:

        async def _inner():
            io = await self.ws.execute(cmd)
            return await io.stdout_str()

        return asyncio.run(_inner())

    def exit(self, cmd: str) -> int:
        io = asyncio.run(self.ws.execute(cmd))
        return io.exit_code

    def cleanup_redis(self) -> None:
        for state in (self.m1, self.m2):
            if state.ptype == "redis":
                asyncio.run(state.resource._store.clear())


def _pair_id(pair: tuple[str, str]) -> str:
    return f"{pair[0]}->{pair[1]}"


def _pair_marks(pair: tuple[str, str]):
    if "redis" in pair and not REDIS_URL:
        return [pytest.mark.skip(reason="REDIS_URL not set")]
    return []


_PARAMS = [
    pytest.param(p, id=_pair_id(p), marks=_pair_marks(p)) for p in _PAIRS
]


@pytest.fixture(params=_PARAMS)
def cross(request, tmp_path):
    pair = request.param
    p1_type, p2_type = pair

    m1 = _build_mount(p1_type, "/m1", tmp_path, 1)
    m2 = _build_mount(p2_type, "/m2", tmp_path, 2)

    ws = Workspace(
        {
            "/m1": (m1.resource, MountMode.WRITE),
            "/m2": (m2.resource, MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/m1"

    buckets: dict[str, dict[str, bytes]] = {}
    if m1.ptype == "s3":
        buckets[m1.s3_bucket] = {}
    if m2.ptype == "s3":
        buckets[m2.s3_bucket] = {}

    env = CrossMountEnv(ws, m1, m2, buckets)

    stack = ExitStack()
    if "s3" in pair:
        stack.enter_context(patch_s3_multi(buckets))
    if "gdrive" in pair:
        gd_pairs = []
        if m1.ptype == "gdrive":
            gd_pairs.append((m1.resource._token_manager, m1.gdrive))
        if m2.ptype == "gdrive":
            gd_pairs.append((m2.resource._token_manager, m2.gdrive))
        stack.enter_context(patch_gdrive(*gd_pairs))

    with stack:
        try:
            yield env
        finally:
            env.cleanup_redis()


def test_cat_cross(cross):
    cross.create_file(1, "a.txt", b"aaa\n")
    cross.create_file(2, "b.txt", b"bbb\n")
    out = cross.run("cat /m1/a.txt /m2/b.txt")
    assert "aaa" in out and "bbb" in out


def test_grep_cross(cross):
    cross.create_file(1, "a.txt", b"hello world\n")
    cross.create_file(2, "b.txt", b"hello there\n")
    out = cross.run("grep hello /m1/a.txt /m2/b.txt")
    assert "/m1/a.txt:" in out
    assert "/m2/b.txt:" in out


def test_head_cross(cross):
    cross.create_file(1, "a.txt", b"a1\na2\na3\n")
    cross.create_file(2, "b.txt", b"b1\nb2\nb3\n")
    out = cross.run("head -n 1 /m1/a.txt /m2/b.txt")
    assert "==> /m1/a.txt <==" in out
    assert "==> /m2/b.txt <==" in out


def test_wc_cross(cross):
    cross.create_file(1, "a.txt", b"line1\nline2\n")
    cross.create_file(2, "b.txt", b"only\n")
    out = cross.run("wc -l /m1/a.txt /m2/b.txt")
    assert "/m1/a.txt" in out and "/m2/b.txt" in out


def test_diff_identical_cross(cross):
    cross.create_file(1, "a.txt", b"same\n")
    cross.create_file(2, "b.txt", b"same\n")
    out = cross.run("diff /m1/a.txt /m2/b.txt")
    assert out == ""


def test_diff_different_cross(cross):
    cross.create_file(1, "a.txt", b"hello\n")
    cross.create_file(2, "b.txt", b"world\n")
    out = cross.run("diff /m1/a.txt /m2/b.txt")
    assert "hello" in out or "world" in out


def test_cmp_identical_cross(cross):
    cross.create_file(1, "a.txt", b"same\n")
    cross.create_file(2, "b.txt", b"same\n")
    code = cross.exit("cmp /m1/a.txt /m2/b.txt")
    assert code == 0


def test_cp_cross(cross):
    cross.create_file(1, "src.txt", b"hello\n")
    code = cross.exit("cp /m1/src.txt /m2/dst.txt")
    if _supports_write(cross.dst_type):
        assert code == 0, f"cp failed for {cross.src_type}->{cross.dst_type}"
        assert cross.run("cat /m2/dst.txt") == "hello\n"
    else:
        assert code != 0, (
            f"cp into read-only {cross.dst_type} should have failed")


def test_mv_cross(cross):
    cross.create_file(1, "src.txt", b"hello\n")
    code = cross.exit("mv /m1/src.txt /m2/moved.txt")
    if _supports_write(cross.dst_type) and _supports_delete(cross.src_type):
        assert code == 0, f"mv failed for {cross.src_type}->{cross.dst_type}"
        assert cross.run("cat /m2/moved.txt") == "hello\n"
        assert cross.exit("cat /m1/src.txt") != 0
    else:
        assert code != 0, (
            f"mv with read-only end ({cross.src_type}->{cross.dst_type}) "
            "should have failed")


def test_cp_recursive_cross(cross):
    cross.create_file(1, "tree/a.txt", b"aaa\n")
    cross.create_file(1, "tree/sub/b.txt", b"bbb\n")
    code = cross.exit("cp -r /m1/tree /m2/copied")
    if _supports_write(cross.dst_type):
        assert code == 0, (
            f"cp -r failed for {cross.src_type}->{cross.dst_type}")
        assert cross.run("cat /m2/copied/a.txt") == "aaa\n"
        assert cross.run("cat /m2/copied/sub/b.txt") == "bbb\n"
    else:
        assert code != 0, (
            f"cp -r into read-only {cross.dst_type} should have failed")


def test_mv_recursive_cross(cross):
    cross.create_file(1, "tree/a.txt", b"aaa\n")
    cross.create_file(1, "tree/sub/b.txt", b"bbb\n")
    code = cross.exit("mv /m1/tree /m2/moved")
    if _supports_write(cross.dst_type) and _supports_delete(cross.src_type):
        assert code == 0, (
            f"mv -r failed for {cross.src_type}->{cross.dst_type}")
        assert cross.run("cat /m2/moved/a.txt") == "aaa\n"
        assert cross.run("cat /m2/moved/sub/b.txt") == "bbb\n"
        assert cross.exit("cat /m1/tree/a.txt") != 0
    else:
        assert code != 0, (
            f"mv -r with read-only end ({cross.src_type}->{cross.dst_type}) "
            "should have failed")

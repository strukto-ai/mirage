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
from contextlib import ExitStack
from unittest.mock import patch

import pytest

from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.write import write_bytes as mem_write
from mirage.provision import Precision
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from tests.commands.native.conftest import (_CORE_MODULES, BUCKET, REGION,
                                            MockAsyncSession)


def _run(ws, cmd):

    async def _inner():
        io = await ws.execute(cmd)
        return await io.stdout_str()

    return asyncio.run(_inner())


def _exit(ws, cmd):
    io = asyncio.run(ws.execute(cmd))
    return io.exit_code


def _make_s3_resource(shared_objects):
    config = S3Config(bucket=BUCKET,
                      region=REGION,
                      aws_access_key_id="testing",
                      aws_secret_access_key="testing")
    return S3Resource(config)


def _make_resource(ptype, tmp_path, idx, shared_s3_objects):
    if ptype == "ram":
        return RAMResource(), None
    elif ptype == "disk":
        root = tmp_path / f"disk{idx}"
        root.mkdir()
        return DiskResource(root=str(root)), root
    elif ptype == "s3":
        return _make_s3_resource(shared_s3_objects), None
    raise ValueError(f"Unknown resource type: {ptype}")


def _write_file(ptype,
                name,
                content,
                disk_root=None,
                s3_objects=None,
                mem_accessor=None):
    path = "/" + name
    if ptype == "ram":
        parts = path.strip("/").split("/")
        for i in range(1, len(parts)):
            d = "/" + "/".join(parts[:i])
            if d not in mem_accessor.store.dirs:
                try:
                    asyncio.run(mkdir(mem_accessor, PathSpec.from_str_path(d)))
                except (FileExistsError, ValueError):
                    pass
        asyncio.run(
            mem_write(mem_accessor, PathSpec.from_str_path(path), content))
    elif ptype == "disk":
        file_path = disk_root / name
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(content)
    elif ptype == "s3":
        s3_objects[name] = content


_PAIRS = [
    ("ram", "ram"),
    ("ram", "s3"),
    ("s3", "ram"),
    ("ram", "disk"),
    ("disk", "ram"),
]


class CrossMountEnv:

    def __init__(self, ws, p1_type, p2_type, p1_root, p2_root,
                 shared_s3_objects, p1_accessor, p2_accessor):
        self.ws = ws
        self._types = (p1_type, p2_type)
        self._roots = (p1_root, p2_root)
        self._s3_objects = shared_s3_objects
        self._accessors = (p1_accessor, p2_accessor)

    def create_file(self, mount_idx, name, content):
        idx = mount_idx - 1
        ptype = self._types[idx]
        _write_file(ptype,
                    name,
                    content,
                    disk_root=self._roots[idx],
                    s3_objects=self._s3_objects,
                    mem_accessor=self._accessors[idx])

    def run(self, cmd):
        return _run(self.ws, cmd)

    def exit(self, cmd):
        return _exit(self.ws, cmd)


@pytest.fixture(params=_PAIRS, ids=[f"{a}->{b}" for a, b in _PAIRS])
def cross(request, tmp_path):
    p1_type, p2_type = request.param

    shared_s3_objects = {}

    p1, p1_root = _make_resource(p1_type, tmp_path, 1, shared_s3_objects)
    p2, p2_root = _make_resource(p2_type, tmp_path, 2, shared_s3_objects)

    ws = Workspace({
        "/m1": (p1, MountMode.WRITE),
        "/m2": (p2, MountMode.WRITE)
    },
                   mode=MountMode.WRITE)
    ws.get_session(ws.default_session_id).cwd = "/m1"

    p1_acc = p1.accessor if hasattr(p1, "accessor") else None
    p2_acc = p2.accessor if hasattr(p2, "accessor") else None

    env = CrossMountEnv(ws, p1_type, p2_type, p1_root, p2_root,
                        shared_s3_objects, p1_acc, p2_acc)

    if p1_type == "s3" or p2_type == "s3":
        mock_session = MockAsyncSession(shared_s3_objects)
        stack = ExitStack()
        for mod in _CORE_MODULES:
            stack.enter_context(
                patch(f"{mod}.async_session", return_value=mock_session))
        with stack:
            yield env
    else:
        yield env


def test_cp_cross(cross):
    cross.create_file(1, "f.txt", b"hello\n")
    cross.run("cp /m1/f.txt /m2/copy.txt")
    assert cross.run("cat /m2/copy.txt") == "hello\n"


def test_mv_cross(cross):
    cross.create_file(1, "f.txt", b"hello\n")
    cross.run("mv /m1/f.txt /m2/moved.txt")
    assert cross.run("cat /m2/moved.txt") == "hello\n"
    assert cross.exit("cat /m1/f.txt") != 0


def test_diff_cross(cross):
    cross.create_file(1, "a.txt", b"hello\n")
    cross.create_file(2, "b.txt", b"world\n")
    result = cross.run("diff /m1/a.txt /m2/b.txt")
    assert "hello" in result or "world" in result


def test_diff_identical_cross(cross):
    cross.create_file(1, "a.txt", b"same\n")
    cross.run("cp /m1/a.txt /m2/b.txt")
    assert cross.run("diff /m1/a.txt /m2/b.txt") == ""


def test_cat_multi_cross(cross):
    cross.create_file(1, "a.txt", b"aaa\n")
    cross.create_file(2, "b.txt", b"bbb\n")
    assert cross.run("cat /m1/a.txt /m2/b.txt") == "aaa\nbbb\n"


def test_head_cross(cross):
    cross.create_file(1, "a.txt", b"aaa\n")
    cross.create_file(2, "b.txt", b"bbb\n")
    result = cross.run("head -n 1 /m1/a.txt /m2/b.txt")
    assert "==> /m1/a.txt <==" in result
    assert "==> /m2/b.txt <==" in result


def test_grep_cross(cross):
    cross.create_file(1, "a.txt", b"hello world\n")
    cross.create_file(2, "b.txt", b"foo bar\n")
    result = cross.run("grep hello /m1/a.txt /m2/b.txt")
    assert "/m1/a.txt:" in result


def test_wc_cross(cross):
    cross.create_file(1, "a.txt", b"one\ntwo\n")
    cross.create_file(2, "b.txt", b"three\n")
    result = cross.run("wc -l /m1/a.txt /m2/b.txt")
    assert "/m1/a.txt" in result
    assert "/m2/b.txt" in result


def test_redirect_cross(cross):
    cross.create_file(1, "f.txt", b"hello\n")
    cross.run("cat /m1/f.txt > /m2/out.txt")
    assert cross.run("cat /m2/out.txt") == "hello\n"


def test_pipe_cross(cross):
    cross.create_file(1, "f.txt", b"hello\nworld\n")
    result = cross.run("cat /m1/f.txt | grep hello")
    assert "hello" in result


def test_cross_resource_md5_fans_out(cross):
    cross.create_file(1, "a.txt", b"hello\n")
    cross.create_file(2, "b.txt", b"world\n")
    single = cross.run("md5 /m1/a.txt") + cross.run("md5 /m2/b.txt")
    assert cross.run("md5 /m1/a.txt /m2/b.txt") == single


def test_cross_resource_du_fans_out(cross):
    cross.create_file(1, "a.txt", b"hello\n")
    cross.create_file(2, "b.txt", b"world!!\n")
    out = cross.run("du -c /m1/a.txt /m2/b.txt")
    assert "6\t/m1/a.txt" in out
    assert "8\t/m2/b.txt" in out
    assert "14\ttotal" in out


def test_cross_resource_file_fans_out(cross):
    cross.create_file(1, "a.txt", b"hello\n")
    cross.create_file(2, "b.txt", b"world\n")
    out = cross.run("file /m1/a.txt /m2/b.txt")
    assert "/m1/a.txt:" in out
    assert "/m2/b.txt:" in out


def test_plan_cross_resource_aggregate_sums(cross):
    cross.create_file(1, "a.txt", b"hello\n")
    cross.create_file(2, "b.txt", b"world\n")
    result = asyncio.run(
        cross.ws.execute("md5 /m1/a.txt /m2/b.txt", provision=True))
    assert result.precision == Precision.EXACT
    assert result.network_read == "12"

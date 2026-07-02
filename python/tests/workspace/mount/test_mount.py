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

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry


def _run(coro):
    return asyncio.run(coro)


# ── prefix validation ──────────────────────────


def test_mount_accepts_root_prefix():
    m = MountEntry("/", RAMResource())
    assert m.prefix == "/"


def test_mount_rejects_no_leading_slash():
    with pytest.raises(ValueError, match="must start with /"):
        MountEntry("data/", RAMResource())


def test_mount_rejects_no_trailing_slash():
    with pytest.raises(ValueError, match="must end with /"):
        MountEntry("/data", RAMResource())


def test_mount_rejects_double_slash():
    with pytest.raises(ValueError, match="must not contain //"):
        MountEntry("/data//sub/", RAMResource())


def test_mount_valid_prefix():
    m = MountEntry("/data/", RAMResource())
    assert m.prefix == "/data/"


# ── read-only enforcement ──────────────────────


def test_read_only_blocks_write_ops():
    reg = MountRegistry()
    reg.mount("/ro/", RAMResource(), MountMode.READ)
    mount = reg.mount_for("/ro/file.txt")
    with pytest.raises(PermissionError, match="read-only"):
        _run(mount.execute_op("write", "/file.txt", data=b"x"))


def test_write_mode_allows_write_ops():
    reg = MountRegistry()
    reg.mount("/rw/", RAMResource(), MountMode.WRITE)
    mount = reg.mount_for("/rw/file.txt")
    _run(mount.execute_op("write", "/new.txt", data=b"hello"))


def test_read_only_blocks_write_cmd():
    reg = MountRegistry()
    reg.mount("/ro/", RAMResource(), MountMode.READ)
    mount = reg.mount_for("/ro/file.txt")
    scope = PathSpec(resource_path=("/ro/newdir").strip("/"),
                     virtual="/ro/newdir",
                     directory="/ro/",
                     resolved=True)
    stdout, io = _run(mount.execute_cmd("mkdir", [scope], [], {}))
    assert io.exit_code != 0
    assert b"read-only" in io.stderr


def test_write_mode_allows_write_cmd():
    reg = MountRegistry()
    reg.mount("/rw/", RAMResource(), MountMode.WRITE)
    mount = reg.mount_for("/rw/file.txt")
    scope = PathSpec(resource_path=("/rw/newdir").strip("/"),
                     virtual="/rw/newdir",
                     directory="/rw/",
                     resolved=True)
    stdout, io = _run(mount.execute_cmd("mkdir", [scope], [], {}))
    assert io.exit_code == 0


def test_read_only_allows_read_cmd():
    reg = MountRegistry()
    reg.mount("/ro/", RAMResource(), MountMode.READ)
    mount = reg.mount_for("/ro/")
    scope = PathSpec(resource_path=("/ro/").strip("/"),
                     virtual="/ro/",
                     directory="/ro/",
                     resolved=False)
    stdout, io = _run(mount.execute_cmd("ls", [scope], [], {}))
    assert io.exit_code == 0


# ── execute_cmd ────────────────────────────────


def test_execute_cmd_cat(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(resource_path=("/data/hello.txt").strip("/"),
                     virtual="/data/hello.txt",
                     directory="/data/",
                     resolved=True)
    stdout, io = _run(mount.execute_cmd("cat", [scope], [], {}))
    assert io.exit_code == 0
    assert stdout is not None


def test_execute_cmd_not_found(registry):
    mount = registry.mount_for("/data/hello.txt")
    stdout, io = _run(mount.execute_cmd("nonexistent_cmd", [], [], {}))
    assert io.exit_code == 127
    assert b"command not found" in io.stderr


def test_execute_cmd_ls(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(resource_path=("/data/").strip("/"),
                     virtual="/data/",
                     directory="/data/",
                     resolved=False)
    stdout, io = _run(mount.execute_cmd("ls", [scope], [], {}))
    assert io.exit_code == 0


def test_execute_cmd_with_flag_kwargs(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(resource_path=("/data/hello.txt").strip("/"),
                     virtual="/data/hello.txt",
                     directory="/data/",
                     resolved=True)
    stdout, io = _run(mount.execute_cmd("cat", [scope], [], {"n": True}))
    assert io.exit_code == 0


def test_execute_cmd_with_texts(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(resource_path=("/data/hello.txt").strip("/"),
                     virtual="/data/hello.txt",
                     directory="/data/",
                     resolved=True)
    stdout, io = _run(mount.execute_cmd("grep", [scope], ["hello"], {}))
    assert io.exit_code == 0


# ── execute_op ─────────────────────────────────


def test_execute_op_stat(registry):
    mount = registry.mount_for("/data/hello.txt")
    result = _run(mount.execute_op("stat", "/hello.txt"))
    assert result is not None
    assert result.size > 0


def test_execute_op_readdir(registry):
    mount = registry.mount_for("/data/")
    result = _run(mount.execute_op("readdir", "/"))
    assert isinstance(result, list)
    assert len(result) > 0


def test_execute_op_no_such_op(registry):
    mount = registry.mount_for("/data/hello.txt")
    with pytest.raises(AttributeError, match="no op"):
        _run(mount.execute_op("nonexistent_op", "/file.txt"))


# ── command resolution ─────────────────────────


def test_resolve_command_exists(registry):
    mount = registry.mount_for("/data/hello.txt")
    cmd = mount.resolve_command("cat")
    assert cmd is not None
    assert cmd.name == "cat"


def test_resolve_command_missing(registry):
    mount = registry.mount_for("/data/hello.txt")
    cmd = mount.resolve_command("nonexistent")
    assert cmd is None

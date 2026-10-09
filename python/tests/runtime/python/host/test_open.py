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
import errno
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.runtime.python.host.open import make_open
from mirage.vfs.ram import RAMVFS

from .conftest import make_ops_with_dir


def _write(ops, path, data):
    asyncio.run(ops.write(path, data))


def _read(ops, path):
    return asyncio.run(ops.read(path))


class TestPatchedOpen:
    def test_read_mounted(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"patched")
        patched = make_open(ops)
        with patched("/data/dir/f.txt", "r") as f:
            assert f.read() == "patched"

    def test_write_mounted(self):
        ops, _ = make_ops_with_dir()
        patched = make_open(ops)
        with patched("/data/dir/new.txt", "w") as f:
            f.write("via open")
        assert _read(ops, "/data/dir/new.txt") == b"via open"

    def test_pathlike_and_positional_encoding_route_to_mount(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", "café".encode("utf-16"))
        patched = make_open(ops)
        with patched(Path("/data/dir/f.txt"), "r", -1, "utf-16") as f:
            assert f.read() == "café"

    def test_mounted_open_validates_builtin_only_arguments(self):
        ops, _ = make_ops_with_dir()
        patched = make_open(ops)
        with pytest.raises(ValueError, match="closefd=False"):
            patched("/data/dir/f.txt", "r", closefd=False)
        with pytest.raises(ValueError, match="opener is not supported"):
            patched("/data/dir/f.txt", "r", opener=lambda _path, _flags: 0)
        with pytest.raises(ValueError, match="unbuffered text"):
            patched("/data/dir/f.txt", "r", 0)

    def test_fallthrough_real_file(self, tmp_path):
        ops, _ = make_ops_with_dir()
        patched = make_open(ops)
        real_file = tmp_path / "real.txt"
        real_file.write_text("real content")
        with patched(str(real_file), "r") as f:
            assert f.read() == "real content"

    def test_fallthrough_preserves_full_open_signature(self, tmp_path):
        ops, _ = make_ops_with_dir()
        patched = make_open(ops)
        real_file = tmp_path / "real.txt"
        real_file.write_bytes("café".encode("utf-16"))
        with patched(real_file, "r", -1, "utf-16") as f:
            assert f.read() == "café"


@pytest.mark.parametrize(
    "path, mode, code",
    [
        ("/data/secret.txt", "r", errno.ENOENT),
        ("/ro/new.txt", "w", errno.EROFS),
        ("/data/sealed/f.txt", "r", errno.EACCES),
    ],
)
def test_open_refuses_what_ws_vfs_refuses(path, mode, code):
    # A hide, a read-only mount and a path rule: both doors ask the
    # dispatcher, so the one refusal comes back through either, open()'s
    # as the class CPython builds for its errno.
    ws = Workspace(
        {"/data/": RAMVFS(), "/ro/": (RAMVFS(), MountMode.READ)},
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.vfs.write("/data/secret.txt", b"s"))
    asyncio.run(ws.vfs.mkdir("/data/sealed"))
    asyncio.run(ws.vfs.write("/data/sealed/f.txt", b"f"))
    profile = {
        "paths": {"hide": ["/data/secret.txt"]},
        "commands": {
            "deny": [{"reason": "sealed", "paths": ["/data/sealed/*"]}]
        },
    }
    asyncio.run(ws.set_session_profile(ws.default_session_id, profile))
    with pytest.raises(OSError) as direct:
        if mode == "r":
            asyncio.run(ws.vfs.read(path))
        else:
            asyncio.run(ws.vfs.write(path, b"x"))
    with ws, pytest.raises(OSError) as opened:
        with open(path, mode) as f:
            if mode == "r":
                f.read()
            else:
                f.write("x")
    assert direct.value.errno == code
    assert type(opened.value) is type(OSError(code, "builtin"))
    assert opened.value.errno == code


def test_a_relative_path_stays_the_hosts_under_a_root_mount(
    tmp_path, monkeypatch
):
    # A mount made at / claims every absolute path, and a relative one
    # still names the process's working directory.
    monkeypatch.chdir(tmp_path)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    with ws:
        with open("here.txt", "w") as f:
            f.write("host")
        with open("/there.txt", "w") as f:
            f.write("mount")
    assert (tmp_path / "here.txt").read_text() == "host"
    assert not Path("/there.txt").exists()

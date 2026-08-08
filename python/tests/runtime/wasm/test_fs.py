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

import errno as host_errno

import pytest

from mirage.runtime.vfs import RuntimeVFS
from mirage.runtime.wasm.abi import FT_DIR, FT_REG, FT_UNKNOWN
from mirage.runtime.wasm.fs import GuestStat, WasmVFS
from mirage.types import FileStat, FileType


class FakeVFS(RuntimeVFS):
    """Core double: real routing and flush logic, fake dispatch.

    Only `_raw` is replaced, so the prefix table, the cross-mount rename
    guard and the append fallback under test are the shipping ones.
    """

    def __init__(self, files=None, dirs=None, prefixes=()):
        super().__init__(dispatch=None,
                         loop=None,
                         mount_prefixes=lambda: list(prefixes))
        self.files = dict(files or {})
        self.dirs = set(dirs or ())
        self.calls = []

    def _raw(self, op, path, **kwargs):
        self.calls.append((op, path, kwargs))
        if op == "stat":
            if path in self.files:
                return FileStat(name=path,
                                size=len(self.files[path]),
                                modified="2026-07-15T00:00:00Z",
                                type=FileType.TEXT)
            if path in self.dirs or path == "/":
                return FileStat(name=path, type=FileType.DIRECTORY)
            raise FileNotFoundError(path)
        if op == "read":
            if path not in self.files:
                raise FileNotFoundError(path)
            return self.files[path]
        if op == "write":
            self.files[path] = kwargs["data"]
            return None
        if op == "create":
            self.files[path] = b""
            return None
        if op == "truncate":
            self.files[path] = b""
            return None
        if op == "unlink":
            del self.files[path]
            return None
        if op == "mkdir":
            self.dirs.add(path)
            return None
        if op == "rmdir":
            self.dirs.discard(path)
            return None
        if op == "rename":
            dst = kwargs["dst"].virtual
            self.files[dst] = self.files.pop(path)
            return None
        if op == "readdir":
            prefix = path.rstrip("/") + "/"
            out = [p for p in self.files if p.startswith(prefix)]
            out += [d + "/" for d in self.dirs if d.startswith(prefix)]
            if not out and path not in self.dirs and path != "/":
                raise FileNotFoundError(path)
            return sorted(out)
        raise NotImplementedError(op)


def test_mount_prefix_routes_to_bridge_even_when_host_file_exists(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "f.txt").write_text("host-side")
    bridge = FakeVFS(files={"/data/f.txt": b"bridge-side"},
                     prefixes=["/data/"])
    fs = WasmVFS(host_root=tmp_path, vfs=bridge)
    assert fs.read("/data/f.txt") == b"bridge-side"


def test_host_serves_paths_outside_mounts(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "os.py").write_text("stdlib")
    bridge = FakeVFS(prefixes=["/data/"])
    fs = WasmVFS(host_root=tmp_path, vfs=bridge)
    assert fs.read("/lib/os.py") == b"stdlib"
    assert bridge.calls == []


def test_missing_host_path_falls_through_to_bridge(tmp_path):
    bridge = FakeVFS(files={"/new.txt": b"ram-root"})
    fs = WasmVFS(host_root=tmp_path, vfs=bridge)
    assert fs.read("/new.txt") == b"ram-root"
    fs.write("/created.txt", b"x")
    assert bridge.files["/created.txt"] == b"x"


def test_host_paths_are_read_only(tmp_path):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    fs = WasmVFS(host_root=tmp_path, vfs=FakeVFS())
    with pytest.raises(PermissionError, match="read-only"):
        fs.write("/python.wasm", b"clobber")
    with pytest.raises(PermissionError, match="read-only"):
        fs.unlink("/python.wasm")
    assert (tmp_path / "python.wasm").read_bytes() == b"\0asm"


def test_no_host_no_bridge_sees_empty_filesystem():
    fs = WasmVFS()
    with pytest.raises(FileNotFoundError):
        fs.stat("/anything")


def test_stat_maps_filestat_fields():
    bridge = FakeVFS(files={"/data/f.txt": b"hello"},
                     dirs={"/data/sub"},
                     prefixes=["/data/"])
    fs = WasmVFS(vfs=bridge)
    st = fs.stat("/data/f.txt")
    assert st == GuestStat(is_dir=False, size=5,
                           mtime_ns=st.mtime_ns) and st.mtime_ns > 0
    assert fs.stat("/data/sub").is_dir is True
    assert fs.stat_or_none("/data/nope") is None


def test_readdir_bridge_marks_kind_from_trailing_slash():
    bridge = FakeVFS(files={"/data/f.txt": b""},
                     dirs={"/data/sub"},
                     prefixes=["/data/"])
    fs = WasmVFS(vfs=bridge)
    assert fs.readdir("/data") == [("f.txt", FT_UNKNOWN), ("sub", FT_DIR)]


def test_readdir_root_merges_host_bridge_and_mounts(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    bridge = FakeVFS(files={"/root.txt": b""}, prefixes=["/data/", "/logs/"])
    fs = WasmVFS(host_root=tmp_path, vfs=bridge)
    assert fs.readdir("/") == [
        ("data", FT_DIR),
        ("lib", FT_DIR),
        ("logs", FT_DIR),
        ("python.wasm", FT_REG),
        ("root.txt", FT_UNKNOWN),
    ]


def test_rename_within_bridge_and_across_routes(tmp_path):
    (tmp_path / "host.txt").write_text("x")
    bridge = FakeVFS(files={"/data/a.txt": b"move-me"}, prefixes=["/data/"])
    fs = WasmVFS(host_root=tmp_path, vfs=bridge)
    fs.rename("/data/a.txt", "/data/b.txt")
    assert bridge.files == {"/data/b.txt": b"move-me"}
    with pytest.raises(OSError) as exc:
        fs.rename("/host.txt", "/data/c.txt")
    assert exc.value.errno == host_errno.EXDEV

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
import os
import time

import pytest

from mirage.ops.namespace_view import merge_readdir
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.vfs import RuntimeVFS
from mirage.runtime.wasm.abi import FT_DIR, FT_REG
from mirage.runtime.wasm.config import WasmFsConfig
from mirage.runtime.wasm.types import GuestStat
from mirage.runtime.wasm.vfs import WasmVFS
from mirage.types import FileStat, FileType
from mirage.utils.stat_view import mtime_ns


class FakeVFS(RuntimeVFS):
    """Core double: real routing and flush logic, fake dispatch.

    Only `_raw` is replaced, so the prefix table, the cross-mount rename
    guard and the append fallback under test are the shipping ones.
    """

    def __init__(self,
                 files=None,
                 dirs=None,
                 prefixes=(),
                 modified="2026-07-15T00:00:00Z"):
        super().__init__(dispatch=None,
                         loop=None,
                         resolver=PrefixResolver(lambda: list(prefixes)))
        self.files = dict(files or {})
        self.dirs = set(dirs or ())
        self.modified = modified
        self.calls = []

    def _raw(self, op, path, **kwargs):
        self.calls.append((op, path, kwargs))
        if op == "stat":
            if path in self.files:
                return FileStat(name=path,
                                size=len(self.files[path]),
                                modified=self.modified,
                                type=FileType.TEXT)
            # The real door answers a directory for a structure-only
            # path (a mount prefix with no backend object behind it).
            roots = {p.rstrip("/") or "/" for p in self.prefixes()}
            if path in self.dirs or path == "/" or path in roots:
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
            # The real door merges child-mount names into readdir; the
            # double rides the same helper so it cannot drift from it.
            return sorted(merge_readdir(out, self.prefixes(), None, path))
        raise NotImplementedError(op)


def test_mount_prefix_routes_to_bridge_even_when_host_file_exists(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "f.txt").write_text("host-side")
    bridge = FakeVFS(files={"/data/f.txt": b"bridge-side"},
                     prefixes=["/data/"])
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), bridge)
    assert fs.read("/data/f.txt") == b"bridge-side"


def test_host_serves_paths_outside_mounts(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "os.py").write_text("stdlib")
    bridge = FakeVFS(prefixes=["/data/"])
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), bridge)
    assert fs.read("/lib/os.py") == b"stdlib"
    assert bridge.calls == []


def test_missing_host_path_falls_through_to_bridge(tmp_path):
    bridge = FakeVFS(files={"/new.txt": b"ram-root"})
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), bridge)
    assert fs.read("/new.txt") == b"ram-root"
    fs.write("/created.txt", b"x")
    assert bridge.files["/created.txt"] == b"x"


def test_host_paths_are_read_only(tmp_path):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), FakeVFS())
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
    fs = WasmVFS(core=bridge)
    st = fs.stat("/data/f.txt")
    assert st == GuestStat(is_dir=False, size=5,
                           mtime_ns=st.mtime_ns) and st.mtime_ns > 0
    assert fs.stat("/data/sub").is_dir is True
    assert fs.stat_or_none("/data/nope") is None


def test_readdir_bridge_resolves_kind_from_slash_or_stat():
    # A slash-marked entry is a directory without a stat; an unmarked
    # one is classified by the stat the same readdir populated, so a
    # guest's d_type is real instead of FT_UNKNOWN.
    bridge = FakeVFS(files={"/data/f.txt": b""},
                     dirs={"/data/sub"},
                     prefixes=["/data/"])
    fs = WasmVFS(core=bridge)
    assert fs.readdir("/data") == [("f.txt", FT_REG), ("sub", FT_DIR)]


def test_readdir_root_merges_host_bridge_and_mounts(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    bridge = FakeVFS(files={"/root.txt": b""}, prefixes=["/data/", "/logs/"])
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), bridge)
    # Mount entries arrive through the core readdir (the door merges
    # them) and resolve as directories through the door's stat, which
    # answers for a structure-only path.
    assert fs.readdir("/") == [
        ("data", FT_DIR),
        ("lib", FT_DIR),
        ("logs", FT_DIR),
        ("python.wasm", FT_REG),
        ("root.txt", FT_REG),
    ]


def test_a_root_mount_does_not_shadow_the_build_directory(tmp_path):
    """`/` is the one prefix that must not become a claim here.

    A claim is exclusive, so a root claim would cover the interpreter's
    own build tree and `import os` would resolve through the workspace
    instead of off disk. The build keeps what it holds and the root
    mount takes the rest, which is the same fallthrough any unclaimed
    path already uses.
    """
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "os.py").write_text("stdlib")
    bridge = FakeVFS(files={
        "/lib/os.py": b"mount-side",
        "/mine.txt": b"root-side"
    },
                     prefixes=["/"])
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), bridge)
    assert fs.read("/lib/os.py") == b"stdlib"
    assert fs.read("/mine.txt") == b"root-side"
    # An empty name would be the root prefix mistaken for a directory.
    assert all(name for name, _ in fs.readdir("/"))


def test_rename_within_bridge_and_across_routes(tmp_path):
    (tmp_path / "host.txt").write_text("x")
    bridge = FakeVFS(files={"/data/a.txt": b"move-me"}, prefixes=["/data/"])
    fs = WasmVFS(WasmFsConfig(host_root=str(tmp_path)), bridge)
    fs.rename("/data/a.txt", "/data/b.txt")
    assert bridge.files == {"/data/b.txt": b"move-me"}
    with pytest.raises(OSError) as exc:
        fs.rename("/host.txt", "/data/c.txt")
    assert exc.value.errno == host_errno.EXDEV


def test_stat_reads_offsetless_stamps_as_utc():
    # R6 acceptance: the wasm translator answers the same epoch as
    # mirage.utils.stat_view for an offset-less stamp, instead of
    # parsing it in the host's local zone.
    if not hasattr(time, "tzset"):
        pytest.skip("tzset unavailable on this platform")
    previous = os.environ.get("TZ")
    os.environ["TZ"] = "America/New_York"
    time.tzset()
    try:
        naive = FakeVFS(files={"/data/f.txt": b"hello"},
                        prefixes=["/data/"],
                        modified="2026-01-02T03:04:05")
        aware = FakeVFS(files={"/data/f.txt": b"hello"},
                        prefixes=["/data/"],
                        modified="2026-01-02T03:04:05+00:00")
        got_naive = WasmVFS(core=naive).stat("/data/f.txt").mtime_ns
        got_aware = WasmVFS(core=aware).stat("/data/f.txt").mtime_ns
        assert got_naive == got_aware
        assert got_naive == mtime_ns(
            FileStat(name="f",
                     type=FileType.TEXT,
                     modified="2026-01-02T03:04:05"))
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()

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

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.ops import Ops
from mirage.ops.config import OpsMount
from mirage.resource.ram import RAMResource
from mirage.resource.ram.store import RAMStore
from mirage.types import FileType, MountMode

from .conftest import _ram_registered_ops, make_ops, run


class TestMountPrefixes:

    def test_mount_prefixes_returns_prefixes(self):
        ops, _ = make_ops()
        assert ops.mount_prefixes() == ["/data/"]

    def test_mount_prefixes_reflects_unmount(self):
        ops, _ = make_ops()
        ops.unmount("/data/")
        assert ops.mount_prefixes() == []


class TestResolve:

    def test_resolve_basic(self):
        ops, _ = make_ops()
        resource_type, rel_path, _, _, mode = ops._resolve("/data/file.txt")
        assert resource_type == "ram"
        assert rel_path == "/file.txt"
        assert mode == MountMode.WRITE

    def test_resolve_nested(self):
        ops, _ = make_ops()
        _, rel_path, _, _, _ = ops._resolve("/data/a/b/c.txt")
        assert rel_path == "/a/b/c.txt"

    def test_resolve_no_match(self):
        ops, _ = make_ops()
        with pytest.raises(ValueError, match="no mount matches"):
            ops._resolve("/other/file.txt")

    def test_resolve_prefix_root(self):
        ops, _ = make_ops()
        _, rel_path, _, _, _ = ops._resolve("/data/")
        assert rel_path == "/"


class TestReadWrite:

    def test_write_and_read(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/file.txt", b"hello"))
        assert run(ops.read("/data/dir/file.txt")) == b"hello"

    def test_read_nonexistent(self):
        ops, _ = make_ops()
        with pytest.raises(FileNotFoundError):
            run(ops.read("/data/nope.txt"))

    def test_write_read_only(self):
        ops, _ = make_ops(mode=MountMode.READ)
        with pytest.raises(PermissionError):
            run(ops.write("/data/file.txt", b"data"))


class TestStat:

    def test_stat_file(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello"))
        s = run(ops.stat("/data/dir/f.txt"))
        assert s.name == "f.txt"
        assert s.size == 5

    def test_stat_dir(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/mydir"))
        s = run(ops.stat("/data/mydir"))
        assert s.type == FileType.DIRECTORY

    def test_stat_nonexistent(self):
        ops, _ = make_ops()
        with pytest.raises(FileNotFoundError):
            run(ops.stat("/data/nope"))


class TestReaddir:

    def test_readdir(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/a.txt", b"a"))
        run(ops.write("/data/dir/b.txt", b"b"))
        entries = run(ops.readdir("/data/dir"))
        assert len(entries) == 2


class TestMkdirRmdir:

    def test_mkdir_and_rmdir(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/newdir"))
        s = run(ops.stat("/data/newdir"))
        assert s.type == FileType.DIRECTORY
        run(ops.rmdir("/data/newdir"))
        with pytest.raises(FileNotFoundError):
            run(ops.stat("/data/newdir"))

    def test_rmdir_nonempty(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"data"))
        with pytest.raises(OSError):
            run(ops.rmdir("/data/dir"))


class TestUnlink:

    def test_unlink(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"data"))
        run(ops.unlink("/data/dir/f.txt"))
        with pytest.raises(FileNotFoundError):
            run(ops.read("/data/dir/f.txt"))


class TestRename:

    def test_rename(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/old.txt", b"content"))
        run(ops.rename("/data/dir/old.txt", "/data/dir/new.txt"))
        assert run(ops.read("/data/dir/new.txt")) == b"content"
        with pytest.raises(FileNotFoundError):
            run(ops.read("/data/dir/old.txt"))


class TestCreateTruncate:

    def test_create(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.create("/data/dir/empty.txt"))
        assert run(ops.read("/data/dir/empty.txt")) == b""

    def test_truncate(self):
        ops, _ = make_ops()
        run(ops.mkdir("/data/dir"))
        run(ops.write("/data/dir/f.txt", b"hello world"))
        run(ops.truncate("/data/dir/f.txt", 5))
        assert run(ops.read("/data/dir/f.txt")) == b"hello"


class TestIsMounted:

    def test_mounted(self):
        ops, _ = make_ops()
        assert ops.is_mounted("/data/file.txt") is True

    def test_not_mounted(self):
        ops, _ = make_ops()
        assert ops.is_mounted("/other/file.txt") is False


class TestMultiMount:

    def test_two_mounts(self):
        store1 = RAMStore()
        store2 = RAMStore()
        ram_ops = _ram_registered_ops()
        mounts = [
            OpsMount("/mem1/", "ram", RAMAccessor(store1),
                     RAMIndexCacheStore(), MountMode.WRITE, ram_ops),
            OpsMount("/mem2/", "ram", RAMAccessor(store2),
                     RAMIndexCacheStore(), MountMode.WRITE, ram_ops),
        ]
        ops = Ops(mounts)
        run(ops.mkdir("/mem1/dir"))
        run(ops.mkdir("/mem2/dir"))
        run(ops.write("/mem1/dir/a.txt", b"from store1"))
        run(ops.write("/mem2/dir/b.txt", b"from store2"))
        assert run(ops.read("/mem1/dir/a.txt")) == b"from store1"
        assert run(ops.read("/mem2/dir/b.txt")) == b"from store2"
        assert store1.files.get("/dir/a.txt") == b"from store1"
        assert store2.files.get("/dir/b.txt") == b"from store2"


class TestOpsViaRegistry:

    @pytest.fixture
    def memory_ops(self):
        resource = RAMResource()
        store = resource._store
        store.dirs.add("/")
        store.files["/test.txt"] = b"hello"
        store.modified["/test.txt"] = "2024-01-01T00:00:00"
        mount = OpsMount(
            prefix="/data/",
            resource_type="ram",
            accessor=resource.accessor,
            index=RAMIndexCacheStore(),
            mode=MountMode.WRITE,
            ops=resource.ops_list(),
        )
        return Ops([mount]), store

    def test_read_via_registry(self, memory_ops):
        ops, _ = memory_ops
        assert run(ops.read("/data/test.txt")) == b"hello"

    def test_write_via_registry(self, memory_ops):
        ops, store = memory_ops
        run(ops.write("/data/test.txt", b"world"))
        assert store.files["/test.txt"] == b"world"

    def test_stat_via_registry(self, memory_ops):
        ops, _ = memory_ops
        st = run(ops.stat("/data/test.txt"))
        assert st.name == "test.txt"

    def test_registry_accessible(self, memory_ops):
        ops, _ = memory_ops
        assert ops._registry is not None
        fn = ops._registry.resolve("read", "ram")
        assert fn is not None

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

import sys

from mirage import MountMode, Workspace
from mirage.ops.os_patch import make_os_module
from mirage.resource.ram import RAMResource

from .conftest import make_ops_with_dir, run


class TestPatchedOs:

    def test_exists(self):
        ops, _ = make_ops_with_dir()
        run(ops.write("/data/dir/f.txt", b"data"))
        patched = make_os_module(ops)
        assert patched.path.exists("/data/dir/f.txt") is True
        assert patched.path.exists("/data/dir/nope.txt") is False

    def test_isfile(self):
        ops, _ = make_ops_with_dir()
        run(ops.write("/data/dir/f.txt", b"data"))
        patched = make_os_module(ops)
        assert patched.path.isfile("/data/dir/f.txt") is True
        assert patched.path.isfile("/data/dir") is False

    def test_isdir(self):
        ops, _ = make_ops_with_dir()
        patched = make_os_module(ops)
        assert patched.path.isdir("/data/dir") is True
        assert patched.path.isdir("/data/dir/f.txt") is False

    def test_listdir(self):
        ops, _ = make_ops_with_dir()
        run(ops.write("/data/dir/a.txt", b"a"))
        run(ops.write("/data/dir/b.txt", b"b"))
        patched = make_os_module(ops)
        entries = patched.listdir("/data/dir")
        assert sorted(entries) == ["a.txt", "b.txt"]

    def test_remove(self):
        ops, _ = make_ops_with_dir()
        run(ops.write("/data/dir/f.txt", b"data"))
        patched = make_os_module(ops)
        patched.remove("/data/dir/f.txt")
        assert patched.path.exists("/data/dir/f.txt") is False

    def test_getsize(self):
        ops, _ = make_ops_with_dir()
        run(ops.write("/data/dir/f.txt", b"12345"))
        patched = make_os_module(ops)
        assert patched.path.getsize("/data/dir/f.txt") == 5

    def test_fallthrough_real_path(self):
        ops, _ = make_ops_with_dir()
        patched = make_os_module(ops)
        assert patched.path.exists("/tmp") is True

    def test_sys_modules_listdir(self):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.ops.mkdir("/mem/dir"))
        run(ws.ops.write("/mem/dir/a.txt", b"a"))
        run(ws.ops.write("/mem/dir/b.txt", b"b"))
        original_os = sys.modules["os"]
        with ws:
            vos = sys.modules["os"]
            entries = vos.listdir("/mem/dir")
            assert sorted(entries) == ["a.txt", "b.txt"]
            assert vos.path.exists("/mem/dir/a.txt") is True
            assert vos.path.exists("/mem/dir/nope.txt") is False
        assert sys.modules["os"] is original_os

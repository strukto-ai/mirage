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
from pathlib import Path

import pytest

from mirage.ops.open import make_open

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

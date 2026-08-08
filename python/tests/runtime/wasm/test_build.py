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

from mirage.runtime.wasm.abi import FT_DIR, FT_REG
from mirage.runtime.wasm.build import BuildDir


def test_target_maps_guest_paths_onto_the_root(tmp_path):
    build = BuildDir(tmp_path)
    assert build.target("/lib/os.py") == tmp_path / "lib" / "os.py"
    assert build.target("/") == tmp_path


def test_has_reports_only_what_is_there(tmp_path):
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    build = BuildDir(tmp_path)
    assert build.has("/python.wasm") is True
    assert build.has("/nope") is False
    # The root is the build itself, so it answers even for an empty one.
    assert build.has("/") is True


def test_read_and_stat_serve_host_files(tmp_path):
    (tmp_path / "os.py").write_text("stdlib")
    build = BuildDir(tmp_path)
    assert build.read("/os.py") == b"stdlib"
    st = build.stat("/os.py")
    assert (st.is_dir, st.size) == (False, 6)
    assert st.mtime_ns > 0


def test_readdir_tags_kinds_and_sorts(tmp_path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "python.wasm").write_bytes(b"\0asm")
    assert BuildDir(tmp_path).readdir("/") == [
        ("lib", FT_DIR),
        ("python.wasm", FT_REG),
    ]


def test_a_missing_path_raises_rather_than_reading_empty(tmp_path):
    build = BuildDir(tmp_path)
    with pytest.raises(FileNotFoundError):
        build.read("/gone.py")
    with pytest.raises(FileNotFoundError):
        build.stat("/gone.py")

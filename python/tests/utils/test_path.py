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

from mirage.utils.path import gnu_basename, gnu_dirname, resolve_path


def test_basename_simple():
    assert gnu_basename("/a/b/c.txt") == "c.txt"


def test_basename_no_slash():
    assert gnu_basename("c.txt") == "c.txt"


def test_basename_trailing_slash():
    assert gnu_basename("/a/b/") == "b"


def test_basename_multiple_trailing_slashes():
    assert gnu_basename("/a/b///") == "b"


def test_basename_root():
    assert gnu_basename("/") == "/"


def test_basename_empty():
    assert gnu_basename("") == ""


def test_basename_strip_suffix():
    assert gnu_basename("/a/b/c.txt", ".txt") == "c"


def test_basename_suffix_equal_to_base_not_stripped():
    assert gnu_basename("/a/.txt", ".txt") == ".txt"


def test_basename_suffix_not_matching():
    assert gnu_basename("/a/c.txt", ".md") == "c.txt"


def test_dirname_simple():
    assert gnu_dirname("/a/b/c.txt") == "/a/b"


def test_dirname_relative_nested():
    assert gnu_dirname("a/b") == "a"


def test_dirname_trailing_slash():
    assert gnu_dirname("/a/b/") == "/a"


def test_dirname_single_absolute():
    assert gnu_dirname("/a") == "/"


def test_dirname_single_relative():
    assert gnu_dirname("a") == "."


def test_dirname_root():
    assert gnu_dirname("/") == "/"


def test_dirname_empty():
    assert gnu_dirname("") == "."


def test_resolve_relative_against_cwd():
    assert resolve_path("file.txt", "/data/") == "/data/file.txt"


def test_resolve_parent_traversal():
    assert resolve_path("../file.txt", "/data/sub/") == "/data/file.txt"


def test_resolve_absolute_ignores_cwd():
    assert resolve_path("/abs/path", "/ignored") == "/abs/path"


def test_resolve_current_dir_segment():
    assert resolve_path("./x", "/a/b") == "/a/b/x"

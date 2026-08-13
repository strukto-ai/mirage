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

from mirage.types import PathSpec
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope


def test_to_scope_keeps_the_path_and_marks_it_resolved():
    spec = _to_scope("/data/sub/file.txt")
    assert spec.virtual == "/data/sub/file.txt"
    assert spec.directory == "/data/sub/"
    assert spec.resource_path == ""
    assert spec.resolved is True


def test_to_scope_reads_the_directory_up_to_the_last_slash():
    assert _to_scope("/file.txt").directory == "/"
    assert _to_scope("/a/b/c").directory == "/a/b/"


def test_to_scope_falls_back_to_root_for_a_slashless_path():
    assert _to_scope("bare").directory == "/"


def test_to_scope_treats_a_trailing_slash_as_the_whole_directory():
    spec = _to_scope("/data/sub/")
    assert spec.virtual == "/data/sub/"
    assert spec.directory == "/data/sub/"


def test_scope_path_passes_a_plain_string_through():
    assert _scope_path("/data/file.txt") == "/data/file.txt"


def test_scope_path_reads_the_virtual_path_off_a_pathspec():
    spec = PathSpec(virtual="/data/file.txt",
                    directory="/data/",
                    resource_path="file.txt")
    assert _scope_path(spec) == "/data/file.txt"

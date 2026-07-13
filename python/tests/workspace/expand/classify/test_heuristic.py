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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.expand.classify.heuristic import (_unescape_path,
                                                        classify_word)
from mirage.workspace.mount import MountRegistry


def test_unescape_backslash_apostrophe():
    assert _unescape_path(r"Zecheng\'s\ Server") == "Zecheng's Server"


def test_unescape_no_backslash():
    assert _unescape_path("normal") == "normal"


def test_unescape_only_space():
    assert _unescape_path(r"hello\ world") == "hello world"


def test_classify_backslash_escaped_absolute():
    registry = MountRegistry()
    resource = RAMResource()
    resource._store.dirs.add("/")
    registry.mount("/ram/", resource, MountMode.WRITE)
    result = classify_word(r"/ram/Zecheng\'s\ Server/", registry, "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/Zecheng's Server"


def test_classify_quoted_path():
    registry = MountRegistry()
    resource = RAMResource()
    resource._store.dirs.add("/")
    registry.mount("/ram/", resource, MountMode.WRITE)
    result = classify_word("/ram/Zecheng's Server/", registry, "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/Zecheng's Server"


def test_bare_filename_stays_text():
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    assert classify_word("file.txt", registry, "/ram") == "file.txt"


def test_relative_subdir_path_resolves():
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    result = classify_word("sub/file.txt", registry, "/ram")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/sub/file.txt"


def test_relative_glob_resolves_against_cwd():
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    result = classify_word("*.txt", registry, "/ram")
    assert isinstance(result, PathSpec)
    assert result.pattern == "*.txt"
    assert result.directory == "/ram/"


def test_bare_glob_operator_stays_text():
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    assert classify_word("*", registry, "/ram") == "*"

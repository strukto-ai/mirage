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
from mirage.workspace.expand.classify.heuristic import classify_word
from mirage.workspace.mount import MountRegistry


def _ram_registry() -> MountRegistry:
    registry = MountRegistry()
    resource = RAMResource()
    resource._store.dirs.add("/")
    registry.mount("/ram/", resource, MountMode.WRITE)
    return registry


# Quote removal is the expansion layer's job and it happens once, so a
# backslash reaching classification is a literal character of the name.
# GNU keeps it: a file named `a\b` is read by `cat '/data/a\b'`.
def test_classify_keeps_literal_backslash():
    result = classify_word(r"/ram/a\b", _ram_registry(), "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == r"/ram/a\b"
    assert result.raw_path == r"/ram/a\b"


def test_classify_keeps_control_char():
    result = classify_word("/ram/x\ty", _ram_registry(), "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/x\ty"


def test_classify_already_unescaped_absolute():
    result = classify_word("/ram/Zecheng's Server/", _ram_registry(), "/")
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

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
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    return registry


def test_bare_filename_resolves_against_cwd():
    result = classify_bare_path("file.txt", _registry(), "/ram")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/file.txt"
    assert result.resolved
    assert result.raw_path == "file.txt"


def test_bare_glob_becomes_pattern():
    result = classify_bare_path("f?.txt", _registry(), "/ram")
    assert isinstance(result, PathSpec)
    assert result.pattern == "f?.txt"
    assert result.directory == "/ram/"


def test_absolute_path_delegates_to_heuristic():
    result = classify_bare_path("/ram/file.txt", _registry(), "/")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/file.txt"

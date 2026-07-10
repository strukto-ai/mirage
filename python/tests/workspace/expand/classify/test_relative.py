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
from mirage.workspace.expand.classify.relative import relative_spec
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    return registry


def test_plain_word_resolves_and_keeps_raw():
    result = relative_spec("sub/a.txt", _registry(), "/ram")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/sub/a.txt"
    assert result.raw_path == "sub/a.txt"
    assert result.resolved
    assert result.pattern is None


def test_glob_word_becomes_pattern():
    result = relative_spec("sub/*.txt", _registry(), "/ram")
    assert isinstance(result, PathSpec)
    assert result.directory == "/ram/sub/"
    assert result.pattern == "*.txt"
    assert not result.resolved
    assert result.raw_path == "sub/*.txt"


def test_dotdot_normalizes():
    result = relative_spec("../x.txt", _registry(), "/ram/sub")
    assert isinstance(result, PathSpec)
    assert result.virtual == "/ram/x.txt"
    assert result.raw_path == "../x.txt"


def test_unmounted_stays_text():
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    assert relative_spec("a.txt", registry, "/elsewhere") == "a.txt"


def test_raw_path_round_trip():
    result = relative_spec("./sub/a.txt", _registry(), "/ram")
    assert isinstance(result, PathSpec)
    assert result.raw_path == "./sub/a.txt"
    assert result.virtual == "/ram/sub/a.txt"

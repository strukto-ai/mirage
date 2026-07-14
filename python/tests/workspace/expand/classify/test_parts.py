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

from mirage.commands.spec.types import OperandKind
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.expand.classify.parts import classify_parts
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/ram/", RAMResource(), MountMode.WRITE)
    return registry


def test_name_never_classified():
    result = classify_parts(["/ram/cat", "/ram/x"], _registry(), "/")
    assert result[0] == "/ram/cat"
    assert isinstance(result[1], PathSpec)


def test_text_kind_keeps_string():
    result = classify_parts(["cat", "/ram/x"],
                            _registry(),
                            "/",
                            word_kinds=[OperandKind.TEXT])
    assert result[1] == "/ram/x"


def test_path_kind_classifies_bare_filename():
    result = classify_parts(["cat", "file.txt"],
                            _registry(),
                            "/ram",
                            word_kinds=[OperandKind.PATH])
    assert isinstance(result[1], PathSpec)
    assert result[1].virtual == "/ram/file.txt"


def test_duplicate_word_kinds_per_slot():
    result = classify_parts(["grep", "*.txt", "*.txt"],
                            _registry(),
                            "/ram",
                            word_kinds=[OperandKind.TEXT, OperandKind.PATH])
    assert result[1] == "*.txt"
    assert isinstance(result[2], PathSpec)
    assert result[2].pattern == "*.txt"


def test_none_kind_falls_back_to_heuristic():
    result = classify_parts(["cat", "/ram/x", "plain"],
                            _registry(),
                            "/",
                            word_kinds=[None, None])
    assert isinstance(result[1], PathSpec)
    assert result[2] == "plain"


def test_empty_parts():
    assert classify_parts([], _registry(), "/") == []

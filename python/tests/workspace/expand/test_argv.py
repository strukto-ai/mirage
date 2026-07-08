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

import dataclasses

import pytest

from mirage.types import PathSpec
from mirage.workspace.expand.argv import Argv


def _ps(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1],
                    resource_path="",
                    resolved=True)


def test_words_includes_name():
    argv = Argv(name="cat", args=("f.txt", ), operands=(_ps("/ram/f.txt"), ))
    assert argv.words == ["cat", _ps("/ram/f.txt")]


def test_words_empty_command():
    assert Argv(name="", args=(), operands=()).words == []


def test_views_may_differ_in_length():
    pattern = _ps("/ram/*.txt")
    argv = Argv(name="ls", args=("a.txt", "b.txt"), operands=(pattern, ))
    assert len(argv.args) == 2
    assert argv.operands == (pattern, )


def test_with_operands_replaces_only_operands():
    argv = Argv(name="rm", args=("link", ), operands=(_ps("/ram/link"), ))
    rewritten = argv.with_operands([_ps("/ram/target")])
    assert rewritten.operands == (_ps("/ram/target"), )
    assert rewritten.name == "rm"
    assert rewritten.args == ("link", )
    assert argv.operands == (_ps("/ram/link"), )


def test_frozen():
    argv = Argv(name="cat", args=(), operands=())
    with pytest.raises(dataclasses.FrozenInstanceError):
        argv.name = "dog"

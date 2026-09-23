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

from mirage.server.summary import _mount_description
from mirage.vfs.ram import RAMVFS

ASTRAL = "\U00010400"


class _PromptVFS(RAMVFS):

    def __init__(self, prompt: str) -> None:
        super().__init__()
        self.PROMPT = prompt


def test_short_prompt_is_returned_whole():
    assert _mount_description(_PromptVFS("hello")) == "hello"
    assert _mount_description(_PromptVFS("")) == ""


def test_budget_counts_code_points():
    # 40 ascii plus 45 Deseret letters is 85 code points and 130 UTF-16
    # units, so the typescript twin ellipsized a prompt this side leaves
    # whole -- and its cut landed inside the 40th surrogate pair.
    prompt = "a" * 40 + ASTRAL * 45
    assert _mount_description(_PromptVFS(prompt)) == prompt


def test_ellipsizes_on_a_code_point_boundary():
    result = _mount_description(_PromptVFS(ASTRAL * 130))
    assert result == ASTRAL * 119 + "…"
    assert len(result) == 120
    assert "�" not in result


def test_trailing_whitespace_is_dropped_before_the_ellipsis():
    prompt = "x" * 118 + "  " + "y" * 10
    assert _mount_description(_PromptVFS(prompt)) == "x" * 118 + "…"

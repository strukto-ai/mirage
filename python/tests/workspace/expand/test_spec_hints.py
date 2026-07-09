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

from mirage import MountMode, RAMResource, Workspace
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import OperandKind
from mirage.workspace.expand.spec_hints import spec_word_kinds

PATH = OperandKind.PATH
TEXT = OperandKind.TEXT


def test_basic_grep_pattern_and_path():
    kinds = spec_word_kinds(SPECS["grep"], ["pattern", "file.txt"])
    assert kinds == [TEXT, PATH]


def test_text_flag_values_positional():
    kinds = spec_word_kinds(SPECS["find"], ["/data", "-name", "*.txt"])
    assert kinds == [PATH, None, TEXT]


def test_long_value_flag_equals_not_classified():
    kinds = spec_word_kinds(SPECS["du"], ["--max-depth=1", "/data"])
    assert kinds == [None, PATH]


def test_mixed_cluster_value_is_text():
    kinds = spec_word_kinds(SPECS["grep"], ["-ne", "pat", "/a.txt"])
    assert kinds == [None, TEXT, PATH]


def test_repeated_dash_e_values_are_text():
    kinds = spec_word_kinds(SPECS["grep"],
                            ["-e", "foo", "-e", "bar", "/a.txt"])
    assert kinds == [None, TEXT, None, TEXT, PATH]


def test_numeric_shorthand_not_a_path():
    kinds = spec_word_kinds(SPECS["head"], ["-5", "file.txt"])
    assert kinds == [None, PATH]


def test_find_ignore_tokens_not_classified():
    kinds = spec_word_kinds(SPECS["find"],
                            ["/data", "(", "-name", "*.txt", ")"])
    assert kinds[0] == PATH
    assert kinds[1] is None
    assert kinds[4] is None


def test_duplicate_word_text_and_path_slots():
    # F8: the same word is the pattern (TEXT) and a file glob (PATH);
    # value sets could not tell the two slots apart.
    kinds = spec_word_kinds(SPECS["grep"], ["*.txt", "*.txt"])
    assert kinds == [TEXT, PATH]


@pytest.mark.asyncio
async def test_du_max_depth_equals_at_root_mount():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("tee /data/sub/n.txt > /dev/null", stdin=b"x\n")

    io = await ws.execute("du --max-depth=1 /data/sub")
    out = (io.stdout or b"").decode()
    assert "--max-depth" not in out
    assert "/data/sub" in out

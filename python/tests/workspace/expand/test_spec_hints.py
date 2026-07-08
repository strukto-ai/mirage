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
from mirage.workspace.expand.spec_hints import spec_word_kinds


def test_basic_grep_pattern_and_path():
    text_set, path_set = spec_word_kinds(SPECS["grep"],
                                         ["pattern", "file.txt"])
    assert text_set == {"pattern"}
    assert path_set == {"file.txt"}


def test_text_flag_values_collected():
    text_set, path_set = spec_word_kinds(SPECS["find"],
                                         ["/data", "-name", "*.txt"])
    assert "*.txt" in text_set
    assert path_set == {"/data"}


def test_long_value_flag_equals_not_a_path():
    text_set, path_set = spec_word_kinds(SPECS["du"],
                                         ["--max-depth=1", "/data"])
    assert "--max-depth=1" not in path_set
    assert "--max-depth=1" not in text_set
    assert path_set == {"/data"}


def test_mixed_cluster_value_not_a_path():
    text_set, path_set = spec_word_kinds(SPECS["grep"],
                                         ["-ne", "pat", "/a.txt"])
    assert text_set == {"pat"}
    assert path_set == {"/a.txt"}


def test_repeated_dash_e_values_are_text():
    text_set, path_set = spec_word_kinds(SPECS["grep"],
                                         ["-e", "foo", "-e", "bar", "/a.txt"])
    assert "foo" in text_set
    assert "bar" in text_set
    assert path_set == {"/a.txt"}


def test_numeric_shorthand_not_a_path():
    text_set, path_set = spec_word_kinds(SPECS["head"], ["-5", "file.txt"])
    assert "-5" not in path_set
    assert path_set == {"file.txt"}


def test_find_ignore_tokens_not_classified():
    text_set, path_set = spec_word_kinds(SPECS["find"],
                                         ["/data", "(", "-name", "*.txt", ")"])
    assert "(" not in path_set and "(" not in text_set
    assert ")" not in path_set and ")" not in text_set


@pytest.mark.asyncio
async def test_du_max_depth_equals_at_root_mount():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("tee /data/sub/n.txt > /dev/null", stdin=b"x\n")

    io = await ws.execute("du --max-depth=1 /data/sub")
    out = (io.stdout or b"").decode()
    assert "--max-depth" not in out
    assert "/data/sub" in out

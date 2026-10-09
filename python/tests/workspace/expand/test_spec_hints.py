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

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.spec import SPECS
from mirage.utils.glob_walk import mark_globs
from mirage.workspace.expand.spec_hints import (
    spec_for_command,
    spec_word_kinds,
)

PATH = "path"
TEXT = "str"


def test_spec_for_command_prefers_cwd_mount():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    mount = ws._registry.mount_for("/")
    spec = spec_for_command("grep", ws._registry, "/")
    assert spec is mount.spec_for("grep")


def test_spec_for_command_falls_back_to_shared_specs():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    mount = ws._registry.mount_for("/")
    name = next(n for n in SPECS if mount.spec_for(n) is None)
    assert spec_for_command(name, ws._registry, "/") is SPECS[name]


def test_spec_for_command_unknown_name_is_none():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    assert spec_for_command("no-such-command", ws._registry, "/") is None


def test_basic_grep_pattern_and_path():
    kinds = spec_word_kinds(SPECS["grep"], ["pattern", "file.txt"])
    assert kinds == [TEXT, PATH]


def test_quoted_expression_tokens_keep_their_roles():
    argv = ["/data", "!", "(", "-name", "a*", ")", "-print"]
    assert spec_word_kinds(
        SPECS["find"], [mark_globs(word) for word in argv], "find"
    ) == [PATH, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT]


def test_text_flag_values_positional():
    kinds = spec_word_kinds(SPECS["find"], ["/data", "-name", "*.txt"])
    assert kinds == [PATH, TEXT, TEXT]


def test_long_value_flag_equals_not_classified():
    kinds = spec_word_kinds(SPECS["du"], ["--max-depth=1", "/data"])
    assert kinds == [TEXT, PATH]


def test_mixed_cluster_value_is_text():
    kinds = spec_word_kinds(SPECS["grep"], ["-ne", "pat", "/a.txt"])
    assert kinds == [TEXT, TEXT, PATH]


def test_repeated_dash_e_values_are_text():
    kinds = spec_word_kinds(
        SPECS["grep"], ["-e", "foo", "-e", "bar", "/a.txt"]
    )
    assert kinds == [TEXT, TEXT, TEXT, TEXT, PATH]


def test_numeric_shorthand_not_a_path():
    kinds = spec_word_kinds(SPECS["head"], ["-5", "file.txt"])
    assert kinds == [TEXT, PATH]


def test_find_ignore_tokens_classified_as_text():
    """Expression syntax is TEXT, never left to the shape heuristic.

    ``None`` used to mean "apply the default classification" here, and
    the default read ``(`` as the bare path ``/(``, so a parenthesised
    expression handed ``find`` two phantom start points on top of the
    real one. Invisible until a start point that does not exist became
    an error, which is what GNU does.
    """
    kinds = spec_word_kinds(
        SPECS["find"], ["/data", "(", "-name", "*.txt", ")"]
    )
    assert kinds[0] == PATH
    assert kinds[1] == TEXT
    assert kinds[4] == TEXT


def test_find_bare_bang_is_text_in_every_expression_position():
    """GNU's `!` carries no dash, so the rest slot's PATH kind claimed it.

    It reads as an expression token wherever an expression may start:
    first word on the line, straight after the start points, or between
    two predicates.
    """
    assert spec_word_kinds(SPECS["find"], ["/data", "!", "-empty"]) == [
        PATH,
        TEXT,
        TEXT,
    ]
    assert spec_word_kinds(
        SPECS["find"], ["/data", "-empty", "!", "-name", "x"]
    ) == [PATH, TEXT, TEXT, TEXT, TEXT]
    assert spec_word_kinds(SPECS["find"], ["!", "-empty"]) == [TEXT, TEXT]


def test_find_bang_as_a_name_pattern_keeps_its_slot():
    """A `!` filling an option's value slot is that value, not grammar."""
    assert spec_word_kinds(SPECS["find"], ["/data", "-name", "!"]) == [
        PATH,
        TEXT,
        TEXT,
    ]


def test_duplicate_word_text_and_path_slots():
    # F8: the same word is the pattern (TEXT) and a file glob (PATH);
    # value sets could not tell the two slots apart.
    kinds = spec_word_kinds(SPECS["grep"], ["*.txt", "*.txt"])
    assert kinds == [TEXT, PATH]


def test_attached_path_value_is_not_a_relative_path():
    # `-o/` is a well-formed first directory, so the shape heuristic
    # took each of these words for a path under the cwd.
    assert spec_word_kinds(
        SPECS["sort"], ["-o/data/s1.txt", "/data/in.txt"]
    ) == [TEXT, PATH]
    assert spec_word_kinds(
        SPECS["grep"], ["-f/data/p.txt", "/data/in.txt"]
    ) == [TEXT, PATH]
    assert spec_word_kinds(SPECS["tar"], ["-cf/data/a.tar", "t"]) == [
        TEXT,
        PATH,
    ]


@pytest.mark.asyncio
async def test_sort_attached_output_writes_the_file():
    ws = Workspace({"/data/": (RAMVFS(), MountMode.WRITE)})
    await ws.shell("printf 'b\\na\\n' > /data/in.txt && mkdir /data/sub")
    io = await ws.shell("sort -o/data/s1.txt /data/in.txt")
    assert io.exit_code == 0, await io.stderr_str()
    io = await ws.shell("cat /data/s1.txt")
    assert await io.stdout_str() == "a\nb\n"
    io = await ws.shell(
        "cd /data && sort -osub/s2.txt in.txt && cat sub/s2.txt"
    )
    assert await io.stdout_str() == "a\nb\n"


@pytest.mark.asyncio
async def test_du_max_depth_equals_at_root_mount():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir -p /data/sub")
    await ws.shell("tee /data/sub/n.txt > /dev/null", stdin=b"x\n")

    io = await ws.shell("du --max-depth=1 /data/sub")
    out = (io.stdout or b"").decode()
    assert "--max-depth" not in out
    assert "/data/sub" in out

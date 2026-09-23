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


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_grep_positional_pattern(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt", b"orange line\nplain line\n")

    io = await workspace.shell("grep orange /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\n"


@pytest.mark.asyncio
async def test_grep_dash_e_matches_like_positional_pattern(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt", b"orange line\nplain line\n")

    io = await workspace.shell("grep -e orange /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\n"


@pytest.mark.asyncio
async def test_grep_repeated_dash_e_matches_any_pattern(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")

    io = await workspace.shell("grep -e orange -e plain /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\nplain line\n"


@pytest.mark.asyncio
async def test_grep_dash_f_reads_patterns_from_file(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")
    await workspace.vfs.write("/data/pats.txt", b"orange\nlast\n")

    io = await workspace.shell("grep -f /data/pats.txt /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\nlast line\n"


@pytest.mark.asyncio
async def test_grep_dash_e_and_dash_f_union(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")
    await workspace.vfs.write("/data/pats.txt", b"last\n")

    io = await workspace.shell("grep -e plain -f /data/pats.txt /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "plain line\nlast line\n"


@pytest.mark.asyncio
async def test_grep_repeated_dash_f_unions_pattern_files(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")
    await workspace.vfs.write("/data/p1.txt", b"orange\n")
    await workspace.vfs.write("/data/p2.txt", b"last\n")

    io = await workspace.shell(
        "grep -f /data/p1.txt -f /data/p2.txt /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\nlast line\n"


@pytest.mark.asyncio
async def test_grep_dash_e_and_repeated_dash_f_union(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")
    await workspace.vfs.write("/data/p1.txt", b"orange\n")
    await workspace.vfs.write("/data/p2.txt", b"last\n")

    io = await workspace.shell(
        "grep -e plain -f /data/p1.txt -f /data/p2.txt /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout
            or b"").decode() == "orange line\nplain line\nlast line\n"


@pytest.mark.asyncio
async def test_grep_color_accepted_as_gnu_noop(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt", b"orange line\nplain line\n")

    io = await workspace.shell("grep --color=auto orange /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\n"
    stderr = io.stderr if isinstance(io.stderr, bytes) else b""
    assert stderr == b""


@pytest.mark.asyncio
async def test_grep_unknown_flag_refuses_with_gnu_error(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt", b"orange line\nplain line\n")

    io = await workspace.shell("grep --bogus orange /data/a.txt")
    assert io.exit_code == 2
    stderr = io.stderr if isinstance(io.stderr, bytes) else b""
    assert b"grep: unrecognized option '--bogus'" in stderr


@pytest.mark.asyncio
async def test_grep_dash_f_empty_file_matches_nothing(workspace):
    # GNU semantics: an empty -f file contains zero patterns and matches
    # nothing (BSD grep diverges and matches everything).
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt", b"orange line\n")
    await workspace.vfs.write("/data/empty.txt", b"")

    io = await workspace.shell("grep -f /data/empty.txt /data/a.txt")
    assert io.exit_code == 1
    assert (io.stdout or b"") == b""


@pytest.mark.asyncio
async def test_grep_v_dash_f_empty_file_matches_all(workspace):
    await workspace.vfs.mkdir("/data")
    await workspace.vfs.write("/data/a.txt", b"orange line\nplain line\n")
    await workspace.vfs.write("/data/empty.txt", b"")

    io = await workspace.shell("grep -v -f /data/empty.txt /data/a.txt")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == "orange line\nplain line\n"


@pytest.mark.asyncio
async def test_usage_error_is_exit_2_with_newline(workspace):
    # Each program refuses a missing pattern in its own words, exit 2: GNU
    # grep prints its synopsis and the help hint (3.11), ripgrep one
    # sentence (14.1.1), and zgrep keeps mirage's own line since the real
    # one is a shell script printing its $0 path.
    expected = {
        "grep": ("Usage: grep [OPTION]... PATTERNS [FILE]...\n"
                 "Try 'grep --help' for more information.\n"),
        "rg":
        "rg: ripgrep requires at least one pattern to execute a search\n",
        "zgrep":
        "zgrep: usage: zgrep [flags] pattern [path]\n",
    }
    for cmd in ("grep", "rg", "zgrep"):
        io = await workspace.shell(cmd)
        assert io.exit_code == 2
        stderr = io.stderr if isinstance(io.stderr, bytes) else b""
        assert stderr == expected[cmd].encode()

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
"""Coverage matrix for shell quoting / escaping edge cases.

Each test is one realistic agent pattern. Failures here surface as
either parser bugs, classifier bugs (TEXT vs PATH), or
expansion-time bugs.
"""

import asyncio

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


def _ws_with_paths():
    ram = RAMResource()
    ram._store.files["/plain.txt"] = b"plain content\n"
    ram._store.files["/my folder/note.txt"] = b"in spaced folder\n"
    ram._store.files["/my folder/My File.txt"] = b"camelcase with space\n"
    ram._store.files["/file's copy.txt"] = b"with apostrophe\n"
    ram._store.files["/数据/中文.txt"] = b"unicode path content\n"
    ram._store.dirs.add("/my folder")
    ram._store.dirs.add("/数据")
    ws = Workspace(resources={"/data/": (ram, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/data"
    return ws


def _stdout(io) -> bytes:
    if io.stdout is None:
        return b""
    if isinstance(io.stdout, bytes):
        return io.stdout
    return b""


def _exec(ws, cmd, **kw):
    return _run(ws.execute(cmd, **kw))


# ── paths with spaces ──────────────────────────────────────


def test_single_quoted_path_with_space():
    ws = _ws_with_paths()
    io = _exec(ws, "cat '/data/my folder/note.txt'")
    assert _stdout(io) == b"in spaced folder\n"


def test_double_quoted_path_with_space():
    ws = _ws_with_paths()
    io = _exec(ws, 'cat "/data/my folder/note.txt"')
    assert _stdout(io) == b"in spaced folder\n"


def test_ls_directory_with_space():
    ws = _ws_with_paths()
    io = _exec(ws, "ls '/data/my folder/'")
    assert b"note.txt" in _stdout(io)


def test_find_name_pattern_with_space():
    ws = _ws_with_paths()
    io = _exec(ws, "find /data -name 'My File.txt'")
    assert b"My File.txt" in _stdout(io)


# ── paths with special chars ───────────────────────────────


def test_double_quoted_path_with_apostrophe():
    """`cat "/data/file's copy.txt"` — apostrophe inside double quotes."""
    ws = _ws_with_paths()
    io = _exec(ws, 'cat "/data/file\'s copy.txt"')
    assert _stdout(io) == b"with apostrophe\n"


# ── unicode in paths ───────────────────────────────────────


def test_unicode_path():
    ws = _ws_with_paths()
    io = _exec(ws, "cat '/data/数据/中文.txt'")
    assert _stdout(io) == b"unicode path content\n"


def test_unicode_directory_listing():
    ws = _ws_with_paths()
    io = _exec(ws, "ls /data/数据/")
    assert b"\xe4\xb8\xad\xe6\x96\x87.txt" in _stdout(io) or \
        "中文.txt".encode() in _stdout(io)


# ── env vars in paths ──────────────────────────────────────


def test_env_var_in_double_quoted_path():
    ws = _ws_with_paths()
    _exec(ws, "export DIR=/data")
    io = _exec(ws, 'cat "$DIR/plain.txt"')
    assert _stdout(io) == b"plain content\n"


def test_env_var_braced_in_double_quoted_path():
    ws = _ws_with_paths()
    _exec(ws, "export DIR=/data")
    io = _exec(ws, 'cat "${DIR}/plain.txt"')
    assert _stdout(io) == b"plain content\n"


def test_env_var_in_single_quoted_path_not_expanded():
    """Single quotes preserve $VAR literally — should fail to find file."""
    ws = _ws_with_paths()
    _exec(ws, "export DIR=/data")
    io = _exec(ws, "cat '$DIR/plain.txt'")
    # Either non-zero exit OR empty stdout (file not found)
    assert io.exit_code != 0 or _stdout(io) == b""


# ── command substitution in args ──────────────────────────


def test_command_sub_as_path():
    ws = _ws_with_paths()
    _exec(ws, "echo /data/plain.txt > /data/path.txt")
    io = _exec(ws, "cat $(cat /data/path.txt)")
    assert _stdout(io) == b"plain content\n"


def test_command_sub_in_grep_pattern():
    ws = _ws_with_paths()
    _exec(ws, "echo plain > /data/needle.txt")
    io = _exec(ws, 'grep "$(cat /data/needle.txt)" /data/plain.txt')
    assert b"plain content" in _stdout(io)


# ── escaping ───────────────────────────────────────────────


def test_escaped_dollar_in_double_quotes():
    r"""`echo "\$PATH"` should print literal $PATH, not expand it."""
    ws = _ws_with_paths()
    io = _exec(ws, 'echo "\\$PATH"')
    assert _stdout(io).strip() == b"$PATH"


def test_single_quoted_dollar_literal():
    """`echo '$PATH'` — single quotes, no expansion."""
    ws = _ws_with_paths()
    io = _exec(ws, "echo '$PATH'")
    assert _stdout(io).strip() == b"$PATH"


def test_double_quoted_var_expanded():
    """`echo "$X"` — var expanded inside double quotes."""
    ws = _ws_with_paths()
    _exec(ws, "export X=hello")
    io = _exec(ws, 'echo "$X"')
    assert _stdout(io).strip() == b"hello"


# ── unquoted backslash escapes (POSIX §2.2.1) ──────────────


def test_close_escape_open_single_quote():
    """`echo 'a'\\''b'` — POSIX close-escape-open trick → literal a'b."""
    ws = _ws_with_paths()
    io = _exec(ws, "echo 'a'\\''b'")
    assert _stdout(io).strip() == b"a'b"


def test_escaped_space_in_path():
    r"""`cat /data/my\ folder/note.txt` — backslash-escaped space."""
    ws = _ws_with_paths()
    io = _exec(ws, "cat /data/my\\ folder/note.txt")
    assert _stdout(io) == b"in spaced folder\n"


def test_unquoted_escaped_dollar():
    r"""`echo \$PATH` — unquoted `\$` is literal `$`."""
    ws = _ws_with_paths()
    io = _exec(ws, "echo \\$PATH")
    assert _stdout(io).strip() == b"$PATH"


def test_unquoted_escaped_backslash():
    r"""`echo \\` — unquoted `\\` is one literal backslash."""
    ws = _ws_with_paths()
    io = _exec(ws, "echo \\\\")
    assert _stdout(io) == b"\\\n"


def test_unquoted_backslash_n_is_literal_n():
    r"""`echo foo\nbar` — `\n` outside quotes is literal `n`, not newline."""
    ws = _ws_with_paths()
    io = _exec(ws, "echo foo\\nbar")
    assert _stdout(io).strip() == b"foonbar"


# ── edge cases ─────────────────────────────────────────────


def test_empty_string_arg():
    ws = _ws_with_paths()
    io = _exec(ws, 'echo ""')
    assert _stdout(io) == b"\n"


def test_consecutive_quoted_strings():
    """`echo "a""b"` should produce `ab` (concatenation)."""
    ws = _ws_with_paths()
    io = _exec(ws, 'echo "a""b"')
    assert _stdout(io).strip() == b"ab"


def test_grep_pattern_with_escaped_quote():
    """`grep "she said \\"hi\\"" file` — literal embedded double quote."""
    ws = _ws_with_paths()
    ram = ws.mount("/data/").resource
    ram._store.files['/quote.txt'] = b'she said "hi"\n'
    io = _exec(ws, 'grep "she said \\"hi\\"" /data/quote.txt')
    assert b"hi" in _stdout(io)


@pytest.mark.parametrize(
    "input_text,expected",
    [
        ("hello world", b"hello world\n"),
        # single quotes are literal inside double quotes (bash behavior)
        ("'inner'", b"'inner'\n"),
        ("$NONEXISTENT", b"\n"),
    ])
def test_echo_quoting_matrix(input_text, expected):
    ws = _ws_with_paths()
    io = _exec(ws, f'echo "{input_text}"')
    assert _stdout(io) == expected


# ── whitespace between expansions inside double quotes ─────


@pytest.mark.parametrize(
    "line,expected",
    [
        # tree-sitter folds the separating whitespace into the *second*
        # node's extent, so each expansion branch has to re-emit it.
        ('echo "$(echo a) $(echo b)"', b"a b\n"),
        ('echo "$(echo a) $(echo b) $(echo c)"', b"a b c\n"),
        ('x=a; echo "$x $(echo b)"', b"a b\n"),
        ('x=a; echo "${x} $(echo b)"', b"a b\n"),
        ('y=b; echo "$(echo a) ${y}"', b"a b\n"),
        ('echo "$((1+1)) $(echo b)"', b"2 b\n"),
        ('echo "$(echo a) $((1+1))"', b"a 2\n"),
        ('echo "$((1+1)) $((2+2))"', b"2 4\n"),
        ('x=a; echo "$x $((1+1))"', b"a 2\n"),
        ('x=a; true; echo "$x $?"', b"a 0\n"),
        ('x=a; set -- p q; echo "$x $#"', b"a 2\n"),
        # a run of whitespace is preserved verbatim, not collapsed
        ('echo "$(echo a)  $(echo b)"', b"a  b\n"),
        ('printf "%s\\n" "$(echo a)\t$(echo b)"', b"a\tb\n"),
        # unquoted words never fold, so word splitting is unchanged
        ("echo $(echo a) $(echo b)", b"a b\n"),
        ("echo $((1+1)) $((2+2))", b"2 4\n"),
        # "${a[@]}" word-splits, and the folded gap joins its first word
        ('x=a; arr=(1 2); echo "$x ${arr[@]}"', b"a 1 2\n"),
        ('arr=(1 2); echo "$(echo p) ${arr[@]}"', b"p 1 2\n"),
        ('arr=(1 2); echo "${arr[@]} ${arr[@]}"', b"1 2 1 2\n"),
        ('x=a; arr=(); echo "[$x ${arr[@]}]"', b"[a ]\n"),
    ])
def test_whitespace_between_expansions_survives(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected


# ── adjacent backtick substitutions ────────────────────────


@pytest.mark.parametrize(
    "line,expected",
    [
        # tree-sitter merges pairs separated by nothing or whitespace
        # into one node, so the region is re-lexed during expansion.
        ("echo `echo a` `echo b`", b"a b\n"),
        ('echo "`echo a` `echo b`"', b"a b\n"),
        ("echo `echo a``echo b`", b"ab\n"),
        ('echo "`echo a``echo b`"', b"ab\n"),
        ("echo `echo a` `echo b` `echo c`", b"a b c\n"),
        ('echo "`echo \'q q\'` `echo b`"', b"q q b\n"),
        # backslash parity: `\\` is one escaped backslash, so the
        # backtick after it still closes the region
        (r"echo `echo 'a\\'`", b"a\\\n"),
        (r"echo `echo 'a\\'` `echo b`", b"a\\ b\n"),
        (r"echo `echo 'a\\b'`", b"a\\b\n"),
        (r"echo `echo 'a\`b'`", b"a`b\n"),
        (r"echo `echo \`echo n\``", b"n\n"),
        # shapes the grammar already handled, kept so the re-lex is
        # proven not to regress them
        ("echo `echo a`", b"a\n"),
        ('echo "`echo a`"', b"a\n"),
        ('echo "x`echo a`y`echo b`z"', b"xaybz\n"),
        ('echo "`echo a` lit `echo b`"', b"a lit b\n"),
        ("echo `echo a` mid `echo b`", b"a mid b\n"),
        ("x=`echo a`; y=`echo b`; echo \"$x $y\"", b"a b\n"),
    ])
def test_adjacent_backtick_substitutions(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected

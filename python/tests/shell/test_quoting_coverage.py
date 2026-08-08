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


# ── ANSI-C quoting $'...' and locale quoting $"..." ────────


@pytest.mark.parametrize(
    "line,expected",
    [
        # expectations pinned against bash 5.2 (docker, C.UTF-8)
        (r"echo $'a\nb'", b"a\nb\n"),
        (r"echo x$'\ty'z", b"x\tyz\n"),
        (r"echo $'\x41\101\u42\U00000043'", b"AABC\n"),
        (r"echo $'a\qb'", b"a\\qb\n"),
        (r"echo $'\x'", b"\\x\n"),
        (r"echo $'it\'s'", b"it's\n"),
        (r"echo $'' y", b" y\n"),
        # NUL truncates the segment alone, not the rest of the word
        (r"printf '[%s]' x$'a\0b'y", b"[xay]"),
        # high bytes survive to output as raw bytes
        (r"echo $'\xe4\xb8\xad'", "中\n".encode()),
        # braces inside the quotes are literal, outside still expand
        (r"echo $'{a,b}'", b"{a,b}\n"),
        (r"echo $'a'{1,2}", b"a1 a2\n"),
        # no expansion of any kind happens inside
        (r"V=w; echo $'$V $(echo x)'", b"$V $(echo x)\n"),
        # assignments and quoted re-reads round-trip
        ("V=$'x\\ty'; echo \"$V\"", b"x\ty\n"),
        # inside double quotes the form is inert text
        ("echo \"$'a\\nb'\"", b"$'a\\nb'\n"),
        # $"..." is plain double-quote semantics (identity translation)
        ('echo $"hello world"', b"hello world\n"),
        ('echo a$"b c"d', b"ab cd\n"),
        ('echo "a"$"c"', b"ac\n"),
        ('V=$"tv"; echo "$V"', b"tv\n"),
        # a bare trailing dollar is still literal text
        ("echo a$", b"a$\n"),
    ])
def test_ansi_c_and_translated_quoting(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected


def test_ansi_c_word_splits_never_happen():
    # The quoted form is one word even with embedded spaces/newlines.
    ws = _ws_with_paths()
    io = _exec(ws, "for i in $'x y'; do echo \"<$i>\"; done")
    assert _stdout(io) == b"<x y>\n"


def test_ansi_c_redirect_target_names_the_file():
    ws = _ws_with_paths()
    _exec(ws, "echo hi > $'f 1.txt'")
    io = _exec(ws, "cat '/data/f 1.txt'")
    assert _stdout(io) == b"hi\n"


def test_ansi_c_herestring_carries_the_decoded_text():
    ws = _ws_with_paths()
    io = _exec(ws, r"grep -c $'\t' <<< $'a\tb'")
    assert _stdout(io) == b"1\n"


def test_ansi_c_in_test_command_is_literal():
    ws = _ws_with_paths()
    io = _exec(ws, "x=a; [[ $x == $'a' ]] && echo eq")
    assert _stdout(io) == b"eq\n"


# ── quoted case patterns (pinned against bash 5.2 in docker) ──


@pytest.mark.parametrize(
    "line,expected",
    [
        ("case a in 'a') echo hit;; *) echo miss;; esac", b"hit\n"),
        ('case a in "a") echo hit;; *) echo miss;; esac', b"hit\n"),
        ("case a in $'a') echo hit;; *) echo miss;; esac", b"hit\n"),
        ('case a in $"a") echo hit;; *) echo miss;; esac', b"hit\n"),
        # A quoted glob is literal; an unquoted one stays live.
        ("case '*' in '*') echo hit;; *) echo other;; esac", b"hit\n"),
        ("case x in '*') echo lit;; *) echo glob;; esac", b"glob\n"),
        # Expansion results are live patterns unless double-quoted.
        ("x='*'; case y in \"$x\") echo lit;; *) echo miss;; esac", b"miss\n"),
        ("x='*'; case '*' in \"$x\") echo hit;; *) echo miss;; esac",
         b"hit\n"),
        ("x='*'; case y in $x) echo glob;; *) echo miss;; esac", b"glob\n"),
        # Patterns are never word-split.
        ("p='a b'; case 'a b' in $p) echo hit;; *) echo miss;; esac", b"hit\n"
         ),
        # Concatenations mix literal and live segments.
        ("case ab in 'a'*) echo hit;; *) echo miss;; esac", b"hit\n"),
        ("case Xb in 'a'*) echo hit;; *) echo miss;; esac", b"miss\n"),
        ('case ab in a"b") echo hit;; *) echo miss;; esac', b"hit\n"),
        # Backslash escapes the next character in an unquoted pattern.
        ("case 'a*b' in a\\*b) echo hit;; *) echo miss;; esac", b"hit\n"),
        ("case aXb in a\\*b) echo hit;; *) echo miss;; esac", b"miss\n"),
        ("case x in \\?) echo hit;; *) echo miss;; esac", b"miss\n"),
        # Escaped-quote coverage: literal class text and quoted alternation.
        ("case '[^a]' in '[^a]') echo hit;; *) echo miss;; esac", b"hit\n"),
        ("case b in [^a]) echo hit;; *) echo miss;; esac", b"hit\n"),
        ("case b in a|'b') echo hit;; *) echo miss;; esac", b"hit\n"),
        ("case '' in '') echo hit;; *) echo miss;; esac", b"hit\n"),
    ])
def test_quoted_case_patterns(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected


def test_ansi_c_case_pattern_matches_decoded_bytes():
    ws = _ws_with_paths()
    io = _exec(ws, "case \"$(printf 'a\\tb')\" in $'a\\tb') echo hit;; esac")
    assert _stdout(io) == b"hit\n"


# ── quoted declaration operands (pinned against bash 5.2) ──


@pytest.mark.parametrize(
    "line,expected",
    [
        ("export 'FOO=bar'; echo [$FOO]", b"[bar]\n"),
        ('x=v; export "FOO=$x"; echo [$FOO]', b"[v]\n"),
        ("export 'A=1' B=2; echo [$A][$B]", b"[1][2]\n"),
        ("export $'T=a\\tb'; printf '[%s]\\n' \"$T\"", b"[a\tb]\n"),
        ("export 'NOEQ'; echo ok$?", b"ok0\n"),
        ("declare 'x=y z'; echo [$x]", b"[y z]\n"),
        # Quoting keeps a compound-looking value scalar, exactly like bash.
        ("declare 'x=(1 2)'; echo [$x] [${x[1]-unset}]", b"[(1 2)] [unset]\n"),
        ("f() { local 'l=v'; echo in:[$l]; }; f; echo out:[$l]",
         b"in:[v]\nout:[]\n"),
        ("readonly 'R=v'; echo [$R]", b"[v]\n"),
    ])
def test_quoted_declaration_operands(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected


# ── quoted parameter-expansion and [[ ]] patterns (pinned against
# bash 5.2 in docker) ──


@pytest.mark.parametrize(
    "line,expected",
    [
        # Quoted parameter-expansion patterns match literally.
        ('v="a*b"; echo "${v#"a*"}"', b"b\n"),
        ('v=aXb; echo "${v#"a*"}"', b"aXb\n"),
        ("v=aXb; echo \"${v#'a*'}\"", b"aXb\n"),
        ('v="a*b"; echo "${v/"*"/y}"', b"ayb\n"),
        ('v="a*b"; echo "${v%"*b"}"', b"a\n"),
        ('v=aXbXc; echo "${v//"X"/-}"', b"a-b-c\n"),
        # Unquoted globs stay live; a backslash binds the next char.
        ("v=aXb; echo ${v#a*}", b"Xb\n"),
        ('v="a*b"; echo ${v#a\\*}', b"b\n"),
        ("v=aXb; echo ${v#a\\*}", b"aXb\n"),
        # Expansion values are live unquoted, literal double-quoted.
        ("p='a*'; v='a*b'; echo \"${v#\"$p\"}\"", b"b\n"),
        ("p='a*'; v='a*b'; echo ${v#$p}", b"*b\n"),
        ("v=$'a\\tb'; echo \"${v#$'a\\t'}\"", b"b\n"),
        # Mixed operands stay one opaque token; quoting inside them
        # still binds (single, double, ANSI-C, quoted refs).
        ("v=ab; echo \"[${v#a'b'}]\"", b"[]\n"),
        ('v="xa*b"; echo "[${v#x"a*"}]"', b"[b]\n"),
        ('v=xaXb; echo "[${v#x"a*"}]"', b"[xaXb]\n"),
        ("v=xy; echo \"[${v#$'x'y}]\"", b"[]\n"),
        ("p='a*'; v='xa*b'; echo \"[${v#x\"$p\"}]\"", b"[b]\n"),
        ("p='a*'; v=xaXb; echo \"[${v#x$p}]\"", b"[Xb]\n"),
        # [[ == ]] renders its right side through the same expander.
        ('x=abc; [[ $x == "a*"* ]] && echo hit || echo miss', b"miss\n"),
        ("x='a*c'; [[ $x == \"a*\"* ]] && echo hit || echo miss", b"hit\n"),
        ('x=aXb; [[ $x == "a"*"b" ]] && echo hit || echo miss', b"hit\n"),
        ('x=ab; [[ $x == "a*" ]] && echo hit || echo miss', b"miss\n"),
        ('x=ab; [[ $x == a* ]] && echo hit || echo miss', b"hit\n"),
        ('x=ab; [[ $x != "a*" ]] && echo hit || echo miss', b"hit\n"),
        ("x=$'a\\tb'; [[ $x == $'a\\tb' ]] && echo hit || echo miss",
         b"hit\n"),
        ('[[ abc < abd ]] && echo hit || echo miss', b"hit\n"),
    ])
def test_quoted_parameter_and_test_patterns(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected


# ── multi-line double-quoted strings (pinned against bash 5.2 in
# docker): the newline bytes belong to no token and must re-emit ──


@pytest.mark.parametrize("line,expected", [
    ('echo "a\nb"', b"a\nb\n"),
    ('echo "a\n\nb"', b"a\n\nb\n"),
    ('echo "\na"', b"\na\n"),
    ('echo "a\n"', b"a\n\n"),
    ('x=1; echo "p$x\n\nq"', b"p1\n\nq\n"),
    ('case "a\nb" in "a\nb") echo hit;; *) echo miss;; esac', b"hit\n"),
])
def test_multiline_double_quoted_strings(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected


# ── a bare $ is a literal word ─────────────────────────────


@pytest.mark.parametrize(
    "line,expected",
    [
        ("echo $", b"$\n"),
        ("echo a$ b", b"a$ b\n"),
        ("echo $ x", b"$ x\n"),
        # Adjacency decides: $"..." is a translated string, $ "..." is
        # two words.
        ('echo $"x"', b"x\n"),
        ('echo $ "x"', b"$ x\n"),
    ])
def test_bare_dollar_is_a_literal_word(line, expected):
    ws = _ws_with_paths()
    io = _exec(ws, line)
    assert _stdout(io) == expected

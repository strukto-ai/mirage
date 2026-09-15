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

import json
from pathlib import Path

import pytest

from mirage import MountMode, RAMResource, Workspace


async def _workspace_at(cwd: str) -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute(f"mkdir -p {cwd}")
    await ws.execute(f"cd {cwd}")
    return ws


@pytest.mark.asyncio
async def test_redirect_bare_target_resolves_against_cwd():
    # A redirect target is a path by definition: `> BARE` must write
    # cwd/BARE even though the bare word would classify as text.
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > BARE")
    io = await ws.execute("cat /data/BARE")
    assert (io.stdout or b"") == b"hi\n"


@pytest.mark.asyncio
async def test_redirect_extensionless_relative_target():
    ws = await _workspace_at("/data")
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("echo hi > sub/OUT")
    io = await ws.execute("cat /data/sub/OUT")
    assert (io.stdout or b"") == b"hi\n"


@pytest.mark.asyncio
async def test_redirect_append_relative_target():
    ws = await _workspace_at("/data")
    await ws.execute("echo one > LOG")
    await ws.execute("echo two >> LOG")
    io = await ws.execute("cat /data/LOG")
    assert (io.stdout or b"") == b"one\ntwo\n"


@pytest.mark.asyncio
async def test_redirect_stdin_relative_source():
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > IN")
    io = await ws.execute("wc -l < IN")
    assert (io.stdout or b"").strip() == b"1"


@pytest.mark.asyncio
async def test_redirect_absolute_target_unchanged():
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > /data/ABS")
    io = await ws.execute("cat /data/ABS")
    assert (io.stdout or b"") == b"hi\n"


async def _stdout(ws: Workspace, cmd: str) -> str:
    io = await ws.execute(cmd)
    return (io.stdout or b"").decode()


@pytest.mark.asyncio
async def test_heredoc_expands_braced_var_and_cmdsub():
    ws = await _workspace_at("/data")
    out = await _stdout(
        ws, 'v=mirage\ncat <<END\nval=$v\nbrace=${v}\nsub=$(echo inner)\nEND')
    assert out == "val=mirage\nbrace=mirage\nsub=inner\n"


@pytest.mark.asyncio
async def test_heredoc_expands_arithmetic():
    # In heredoc bodies tree-sitter parses $((...)) as a command
    # substitution wrapping a subshell; it must still evaluate as math.
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END\nmath=$((2 + 3))\nEND")
    assert out == "math=5\n"


@pytest.mark.asyncio
async def test_heredoc_undefined_var_expands_empty():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END\n[$__undefined_var__]\nEND")
    assert out == "[]\n"


@pytest.mark.asyncio
async def test_heredoc_escaped_dollar_stays_literal():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "v=real\ncat <<END\nesc=\\$v exp=$v\nEND")
    assert out == "esc=$v exp=real\n"


@pytest.mark.asyncio
async def test_heredoc_backslash_newline_joins_lines():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END\nline \\\njoined\nEND")
    assert out == "line joined\n"


@pytest.mark.asyncio
async def test_heredoc_quoted_delimiter_disables_expansion():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "v=zzz\ncat <<'END'\nraw=$v\nsub=$(echo x)\nEND")
    assert out == "raw=$v\nsub=$(echo x)\n"


@pytest.mark.asyncio
async def test_heredoc_partially_quoted_delimiter_disables_expansion():
    # Any quoting anywhere in the delimiter counts (bash semantics).
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<EN'D'\nmixed=$((1+1))\nEND\n")
    assert out == "mixed=$((1+1))\n"


@pytest.mark.asyncio
async def test_heredoc_dash_strips_tabs_not_spaces():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<-END\n\ttab-stripped\n   spaces-kept\nEND")
    assert out == "tab-stripped\n   spaces-kept\n"


@pytest.mark.asyncio
async def test_heredoc_dash_strips_tabs_before_expansion():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "v=deep\ncat <<-END\n\t$v\n\t\tEND")
    assert out == "deep\n"


@pytest.mark.asyncio
async def test_heredoc_into_pipeline():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END | tr a-z A-Z\nshout this\nEND")
    assert out == "SHOUT THIS\n"


@pytest.mark.asyncio
async def test_procsub_stdin_redirect():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "sort < <(printf 'b\\na\\n')")
    assert out == "a\nb\n"


@pytest.mark.asyncio
async def test_procsub_output_redirect_errors_loudly():
    # `> >(cmd)` would classify the procsub text as a literal filename
    # and write silently wrong state; it must fail like argv-position
    # output procsub.
    ws = await _workspace_at("/data")
    io = await ws.execute("echo hi > >(cat)")
    assert io.exit_code == 2
    assert b"unsupported: process substitution" in (io.stderr or b"")


# ── quoted redirect targets ────────────────────


@pytest.mark.parametrize("target", ["'/data/Q'", '"/data/Q"', "/data/Q"])
@pytest.mark.asyncio
async def test_redirect_target_quoting_is_syntactic(target: str):
    # Quoting a redirect target names the same file in bash. A
    # single-quoted target used to leave the parsed target empty, so the
    # write silently went nowhere and exited 0 (silent data loss).
    ws = await _workspace_at("/data")
    io = await ws.execute(f"printf 'V\\n' > {target}")
    assert io.exit_code == 0
    assert (io.stderr or b"") == b""
    assert await _stdout(ws, "cat /data/Q") == "V\n"


@pytest.mark.asyncio
async def test_redirect_single_quoted_target_appends():
    ws = await _workspace_at("/data")
    await ws.execute("printf 'one\\n' > '/data/APP'")
    await ws.execute("printf 'two\\n' >> '/data/APP'")
    assert await _stdout(ws, "cat /data/APP") == "one\ntwo\n"


@pytest.mark.asyncio
async def test_redirect_single_quoted_stderr_target_captures():
    # The empty-target fallback swallowed stderr entirely: the command
    # failed with no message anywhere.
    ws = await _workspace_at("/data")
    io = await ws.execute("cat /data/missing 2> '/data/ERR'")
    assert io.exit_code != 0
    assert b"No such file or directory" in (await
                                            _stdout(ws,
                                                    "cat /data/ERR")).encode()


@pytest.mark.asyncio
async def test_redirect_single_quoted_stdin_source_reads_file():
    ws = await _workspace_at("/data")
    await ws.execute("printf 'a\\nb\\n' > /data/IN")
    assert await _stdout(ws, "wc -l < '/data/IN'") == "2\n"


@pytest.mark.asyncio
async def test_redirect_single_quoted_both_streams_target():
    ws = await _workspace_at("/data")
    await ws.execute("{ echo out; echo err >&2; } &> '/data/BOTH'")
    assert await _stdout(ws, "cat /data/BOTH") == "out\nerr\n"


@pytest.mark.asyncio
async def test_single_quoted_targets_do_not_alias_each_other():
    # Every single-quoted target collapsed to the same empty path, so
    # distinct files aliased onto one phantom entry and a read of an
    # unrelated name returned another file's bytes. Asserted on the
    # bytes rather than the message: the missing-source wording for `<`
    # still differs between the hosts and from GNU.
    ws = await _workspace_at("/data")
    await ws.execute("printf 'first\\n' > '/data/A1'")
    io = await ws.execute("cat < '/data/A2'")
    assert io.exit_code != 0
    assert b"first" not in (io.stdout or b"")


@pytest.mark.asyncio
async def test_redirect_single_quoted_target_with_space():
    ws = await _workspace_at("/data")
    await ws.execute("printf 'S\\n' > '/data/sp ace.txt'")
    assert await _stdout(ws, "cat '/data/sp ace.txt'") == "S\n"


@pytest.mark.asyncio
async def test_herestring_single_quoted_body_into_redirect():
    # `<<< 'text'` shares the target-type gate; it delivered an empty
    # body (a bare newline) instead of the text.
    ws = await _workspace_at("/data")
    await ws.execute("cat <<< 'hi' > /data/HS")
    assert await _stdout(ws, "cat /data/HS") == "hi\n"


# tree-sitter-bash 0.25.1 splits a later unbraced `$var` out of a word
# when a name-terminating character follows it, so `> /api/$c/$id.json`
# used to write a file literally named `$` under /api/<c>. parse()
# repairs the tree; these pin the end-to-end behavior.


@pytest.mark.asyncio
async def test_redirect_second_unbraced_var_with_suffix():
    ws = await _workspace_at("/data")
    await ws.execute("c=aa; id=1; mkdir -p /api/$c")
    io = await ws.execute("echo hi > /api/$c/$id.json")
    assert io.exit_code == 0
    assert await _stdout(ws, "cat /api/aa/1.json") == "hi\n"
    assert await _stdout(ws, "find /api -type f") == "/api/aa/1.json\n"


@pytest.mark.asyncio
async def test_heredoc_into_second_unbraced_var_target():
    ws = await _workspace_at("/data")
    await ws.execute("c=aa; id=1; mkdir -p /api/$c")
    await ws.execute("cat > /api/$c/$id.json <<EOF\nbody\nEOF")
    assert await _stdout(ws, "cat /api/aa/1.json") == "body\n"


@pytest.mark.asyncio
async def test_redirect_three_unbraced_vars_no_suffix():
    ws = await _workspace_at("/data")
    await ws.execute("a=x; b=y; c=z; mkdir -p /w/$a/$b")
    await ws.execute("echo hi > /w/$a/$b/$c")
    assert await _stdout(ws, "cat /w/x/y/z") == "hi\n"


@pytest.mark.asyncio
async def test_word_second_unbraced_var_stays_one_argument():
    ws = await _workspace_at("/data")
    assert await _stdout(
        ws, "c=aa; id=1; echo /api/$c/$id.json") == "/api/aa/1.json\n"


@pytest.mark.asyncio
async def test_assignment_second_unbraced_var_stays_assignment():
    ws = await _workspace_at("/data")
    assert await _stdout(
        ws, "c=aa; id=1; p=/api/$c/$id.json; echo $p") == "/api/aa/1.json\n"


# tree-sitter-bash used to lex a heredoc body line opening with a backslash
# as more words of the operator line, and to skip the first line's leading
# whitespace; parse() shields such bodies so the workspace reads them as
# bash does (issue #1050).


@pytest.mark.asyncio
async def test_heredoc_keeps_a_leading_backslash_line():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<'END'\n\\first\nsecond\nEND")
    assert out == "\\first\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_leading_backslash_line_round_trips_through_a_file():
    ws = await _workspace_at("/data")
    await ws.execute("cat > /data/HB <<'END'\n\\first\nsecond\nEND")
    assert await _stdout(ws, "cat /data/HB") == "\\first\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_keeps_indentation_after_a_backslash_line():
    ws = await _workspace_at("/data")
    body = ("\\begin{table}[!ht]\n  \\begin{center}\n"
            "  \\end{center}\n\\end{table}\n")
    assert await _stdout(ws, f"cat <<'END'\n{body}END") == body


@pytest.mark.asyncio
async def test_heredoc_keeps_leading_indentation():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<'END'\n  first\nsecond\nEND")
    assert out == "  first\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_unquoted_backslash_line_expands_and_escapes():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "hb=val; cat <<END\n\\a $hb\n\\$hb\nsecond\nEND")
    assert out == "\\a val\n$hb\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_backslash_line_does_not_reach_the_pipeline():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<'END' | tr a-z A-Z\n\\first\nsecond\nEND")
    assert out == "\\FIRST\nSECOND\n"


@pytest.mark.asyncio
async def test_heredoc_apostrophe_on_a_backslash_line_is_body_text():
    ws = await _workspace_at("/data")
    io = await ws.execute(
        "cat <<'END'\n\\item Don't stop; echo not-a-command\nsecond\nEND")
    assert io.exit_code == 0
    assert (io.stdout or b"").decode() == (
        "\\item Don't stop; echo not-a-command\nsecond\n")


@pytest.mark.asyncio
async def test_heredoc_dash_keeps_a_tab_indented_backslash_line():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<-'END'\n\t\\first\n\tsecond\n\tEND")
    assert out == "\\first\nsecond\n"


# bash keeps the empty lines a body opens with and reads a quoted
# delimiter with the shell's own escape rules; both reach the workspace
# through the heredoc package (issue #1050).


@pytest.mark.asyncio
async def test_heredoc_keeps_a_leading_empty_line():
    ws = await _workspace_at("/data")
    assert await _stdout(ws, "cat <<'END'\n\nfirst\nEND") == "\nfirst\n"


@pytest.mark.asyncio
async def test_heredoc_keeps_a_body_that_is_one_empty_line():
    ws = await _workspace_at("/data")
    assert await _stdout(ws, "cat <<'END'\n\nEND") == "\n"


@pytest.mark.asyncio
async def test_heredoc_keeps_an_empty_line_before_a_backslash_line():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<'END'\n\n\\first\nEND")
    assert out == "\n\\first\n"


@pytest.mark.asyncio
async def test_heredoc_expands_after_leading_empty_lines():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "hb=val; cat <<END\n\n\n$hb\nEND")
    assert out == "\n\nval\n"


@pytest.mark.asyncio
async def test_heredoc_dash_keeps_a_leading_empty_line():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<-'END'\n\n\tfirst\n\tEND")
    assert out == "\nfirst\n"


@pytest.mark.asyncio
async def test_heredoc_reads_an_escaped_dollar_in_a_quoted_delimiter():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, 'cat <<"E\\$F"\n\\first\nE$F')
    assert out == "\\first\n"


@pytest.mark.asyncio
async def test_heredoc_reads_an_escaped_quote_in_a_quoted_delimiter():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, 'cat <<"E\\"F"\n\\first\nE"F')
    assert out == "\\first\n"


@pytest.mark.asyncio
async def test_heredoc_leading_empty_line_round_trips_through_a_file():
    ws = await _workspace_at("/data")
    await ws.execute("cat > /data/HB7 <<'END'\n\nfirst\nEND")
    assert await _stdout(ws, "cat /data/HB7") == "\nfirst\n"


# A backslash before a newline in the delimiter is the reader's line
# continuation rather than quoting, so the body it opens expands, and the
# terminator line tree-sitter leaves in that body is not body text
# (issue #1050).


@pytest.mark.asyncio
async def test_heredoc_continued_delimiter_expands_its_body():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "hb=val; cat <<EO\\\nF\n$hb\nEOF\n")
    assert out == "val\n"


@pytest.mark.asyncio
async def test_heredoc_continued_delimiter_drops_its_terminator_line():
    ws = await _workspace_at("/data")
    assert await _stdout(ws, "cat <<EO\\\nF\nbody\nEOF\n") == "body\n"


@pytest.mark.asyncio
async def test_heredoc_continued_delimiter_with_an_escape_is_quoted():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "hb=val; cat <<EO\\\nF\\G\n$hb\nEOFG\n")
    assert out == "$hb\n"


@pytest.mark.asyncio
async def test_heredoc_body_expanding_to_the_delimiter_is_kept():
    ws = await _workspace_at("/data")
    assert await _stdout(ws, "hb=END; cat <<END\n$hb\nEND") == "END\n"


# The operator line runs past a `)` that closes a case pattern and past
# the quotes a substitution inside double quotes holds, so the body it
# opens is the one bash reads (issue #1050).


@pytest.mark.asyncio
async def test_heredoc_body_after_a_case_pattern_paren():
    ws = await _workspace_at("/data")
    line = ("cat <<EOF $(case x in\nx)\n  :\n  ;;\nesac\n)\n"
            "\\first\nsecond\nEOF\n")
    assert await _stdout(ws, line) == "\\first\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_body_after_a_case_pattern_keeps_indentation():
    ws = await _workspace_at("/data")
    line = ("cat <<EOF $(case x in\nx)\n  :\n  ;;\nesac\n)\n"
            "  spaced\nsecond\nEOF\n")
    assert await _stdout(ws, line) == "  spaced\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_body_after_a_quote_inside_a_substitution():
    ws = await _workspace_at("/data")
    line = ('cat <<EOF >"$( : "a\n  b"; echo /data/HB8)"\n'
            "\\first\nsecond\nEOF\n")
    await ws.execute(line)
    assert await _stdout(ws, "cat /data/HB8") == "\\first\nsecond\n"


@pytest.mark.asyncio
async def test_heredoc_body_after_a_quote_inside_a_backtick():
    ws = await _workspace_at("/data")
    line = ('cat <<EOF >"`  : "a\n  b"; echo /data/HB9 `"\n'
            "\\first\nsecond\nEOF\n")
    await ws.execute(line)
    assert await _stdout(ws, "cat /data/HB9") == "\\first\nsecond\n"


HEREDOC_CASES = json.loads(
    (Path(__file__).resolve().parents[4] /
     "integ/bash/heredoc/reader.json").read_text())["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", HEREDOC_CASES, ids=lambda case: case["id"])
async def test_heredoc_reader_integration(case):
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(case["command"])
        assert {
            "exit": io.exit_code,
            "stdout": await io.stdout_str(),
            "stderr": (await io.materialize_stderr()).decode()
        } == case["expect"]
    finally:
        await ws.close()


NESTED_HEREDOC_CASES = json.loads(
    (Path(__file__).resolve().parents[4] /
     "integ/crossmount/nested/heredoc.json").read_text())["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case",
                         NESTED_HEREDOC_CASES,
                         ids=lambda case: case["id"])
async def test_heredoc_nested_mount_integration(case):
    parent, child, ghost = RAMResource(), RAMResource(), RAMResource()
    ws = Workspace(
        {
            "/data": parent,
            "/data/inner": child,
            "/ghost/deep": ghost
        },
        mode=MountMode.WRITE)
    try:
        io = await ws.execute(case["command"])
        assert {
            "exit": io.exit_code,
            "stdout": await io.stdout_str(),
            "stderr": (await io.materialize_stderr()).decode()
        } == case["expect"]
        # A longest-prefix routing bug can read back its own misplaced write;
        # inspect ownership too, so a false round trip cannot pass.
        assert not any(
            key.startswith("/inner/") for key in parent._store.files)
        assert child._store.files or ghost._store.files
    finally:
        await ws.close()

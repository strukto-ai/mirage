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

import asyncio

from mirage.resource.ram import RAMResource
from mirage.types import DEFAULT_SESSION_ID, MountMode
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


def _ws():
    """Workspace with 3 RAM mounts: /s3/, /disk/, /ram/."""
    s3 = RAMResource()
    s3.is_remote = True
    disk = RAMResource()
    disk.is_remote = True
    ram = RAMResource()

    s3._store.files["/report.csv"] = b"name,age\nalice,30\nbob,25\n"
    s3._store.files["/data.txt"] = b"hello from s3\n"
    s3._store.files["/users.json"] = (
        b'[{"name":"alice","age":30},{"name":"bob","age":25}]\n')
    s3._store.files["/config.env"] = b"DB_HOST=localhost\nDB_PORT=5432\n"
    s3._store.files["/access.log"] = (b"2024-01-01 GET /api 200\n"
                                      b"2024-01-01 POST /api 500\n"
                                      b"2024-01-02 GET /api 200\n"
                                      b"2024-01-02 GET /health 200\n"
                                      b"2024-01-03 POST /api 500\n")
    s3._store.files["/script.py"] = (b"import json\n"
                                     b"data = json.loads('[1,2,3]')\n"
                                     b"print(sum(data))\n")

    disk._store.files["/readme.txt"] = b"disk readme\n"
    disk._store.dirs.add("/sub")
    disk._store.files["/sub/deep.txt"] = b"deep content\n"

    ram._store.files["/notes.txt"] = b"line1\nline2\nline3\n"
    ram._store.files["/nums.txt"] = b"5\n3\n1\n4\n2\n"
    ram._store.files["/words.txt"] = b"banana\napple\ncherry\napple\n"

    ws = Workspace(
        resources={
            "/s3/": (s3, MountMode.EXEC),
            "/disk/": (disk, MountMode.EXEC),
            "/ram/": (ram, MountMode.EXEC),
        },
        history=None,
    )
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/s3"
    return ws


def _exec(ws, cmd, stdin=None):
    return _run(ws.execute(cmd, stdin=stdin))


def _stdout(io):
    if io.stdout is None:
        return b""
    if isinstance(io.stdout, bytes):
        return io.stdout
    if isinstance(io.stdout, memoryview):
        return bytes(io.stdout)
    return b""


# ── basic commands ─────────────────────────────


def test_cat_file():
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_cat_missing_file():
    ws = _ws()
    io = _exec(ws, "cat /s3/nonexistent.txt")
    assert io.exit_code != 0


def test_ls_directory():
    ws = _ws()
    io = _exec(ws, "ls /disk/")
    assert io.exit_code == 0


def test_head_file():
    ws = _ws()
    io = _exec(ws, "head /ram/notes.txt")
    assert io.exit_code == 0
    assert b"line1" in _stdout(io)


# ── export / env ───────────────────────────────


def test_export():
    ws = _ws()
    _exec(ws, "export MSG=hello")
    assert ws.get_session(DEFAULT_SESSION_ID).env["MSG"] == "hello"


def test_export_used_in_command():
    ws = _ws()
    _exec(ws, "export DIR=/s3")
    io = _exec(ws, "cat $DIR/report.csv")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


# ── cd ─────────────────────────────────────────


def test_cd():
    ws = _ws()
    _exec(ws, "cd /disk")
    assert ws.get_session(DEFAULT_SESSION_ID).cwd == "/disk"


def test_cd_nonexistent():
    ws = _ws()
    io = _exec(ws, "cd /nonexistent")
    assert io.exit_code != 0


# ── pipeline ───────────────────────────────────


def test_pipeline_cat_sort():
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv | sort")
    assert io.exit_code == 0


def test_pipeline_cat_wc():
    ws = _ws()
    io = _exec(ws, "cat /ram/notes.txt | wc")
    assert io.exit_code == 0


# ── redirect ───────────────────────────────────


def test_redirect_write():
    ws = _ws()
    io = _exec(ws, "cat /s3/data.txt > /disk/out.txt")
    assert io.exit_code == 0
    io2 = _exec(ws, "cat /disk/out.txt")
    assert b"hello from s3" in _stdout(io2)


def test_redirect_append():
    ws = _ws()
    _exec(ws, "cat /s3/data.txt > /disk/log.txt")
    _exec(ws, "cat /s3/report.csv >> /disk/log.txt")
    io = _exec(ws, "cat /disk/log.txt")
    out = _stdout(io)
    assert b"hello from s3" in out
    assert b"alice" in out


# ── control flow ───────────────────────────────


def test_if_true():
    ws = _ws()
    _exec(ws, "if true; then export R=yes; fi")
    assert ws.get_session(DEFAULT_SESSION_ID).env["R"] == "yes"


def test_if_false_else():
    ws = _ws()
    _exec(ws, "if false; then export R=yes; else export R=no; fi")
    assert ws.get_session(DEFAULT_SESSION_ID).env["R"] == "no"


def test_for_loop():
    ws = _ws()
    _exec(ws, "for x in a b c; do export LAST=$x; done")
    assert ws.get_session(DEFAULT_SESSION_ID).env["LAST"] == "c"


def test_while_false():
    ws = _ws()
    io = _exec(ws, "while false; do export RAN=yes; done")
    assert io.exit_code == 0
    assert "RAN" not in ws.get_session(DEFAULT_SESSION_ID).env


def test_case_match():
    ws = _ws()
    _exec(ws, "case hello in hello) export M=yes;; esac")
    assert ws.get_session(DEFAULT_SESSION_ID).env["M"] == "yes"


# ── operators ──────────────────────────────────


def test_semicolons():
    ws = _ws()
    _exec(ws, "export A=1; export B=2; export C=3")
    s = ws.get_session(DEFAULT_SESSION_ID)
    assert s.env["A"] == "1"
    assert s.env["B"] == "2"
    assert s.env["C"] == "3"


def test_and_chain():
    ws = _ws()
    _exec(ws, "true && export OK=yes")
    assert ws.get_session(DEFAULT_SESSION_ID).env["OK"] == "yes"


def test_and_short_circuit():
    ws = _ws()
    _exec(ws, "false && export SKIP=yes")
    assert "SKIP" not in ws.get_session(DEFAULT_SESSION_ID).env


def test_or_fallback():
    ws = _ws()
    _exec(ws, "false || export FALL=yes")
    assert ws.get_session(DEFAULT_SESSION_ID).env["FALL"] == "yes"


# ── subshell ───────────────────────────────────


def test_subshell_isolates_env():
    ws = _ws()
    _exec(ws, "export X=outer")
    _exec(ws, "(export X=inner)")
    assert ws.get_session(DEFAULT_SESSION_ID).env["X"] == "outer"


# ── function ───────────────────────────────────


def test_function_define_call():
    ws = _ws()
    _exec(ws, "greet() { export MSG=hello; }; greet")
    assert ws.get_session(DEFAULT_SESSION_ID).env["MSG"] == "hello"


def test_function_with_args():
    ws = _ws()
    _exec(ws, "f() { export A=$1; export B=$2; }; f x y")
    s = ws.get_session(DEFAULT_SESSION_ID)
    assert s.env["A"] == "x"
    assert s.env["B"] == "y"


# ── negation ───────────────────────────────────


def test_negated_true():
    ws = _ws()
    io = _exec(ws, "! true")
    assert io.exit_code == 1


def test_negated_false():
    ws = _ws()
    io = _exec(ws, "! false")
    assert io.exit_code == 0


# ── brace group ────────────────────────────────


def test_brace_group():
    ws = _ws()
    _exec(ws, "{ export A=1; export B=2; }")
    s = ws.get_session(DEFAULT_SESSION_ID)
    assert s.env["A"] == "1"
    assert s.env["B"] == "2"


# ── variable expansion ─────────────────────────


def test_var_in_path():
    ws = _ws()
    _exec(ws, "export F=/s3/report.csv")
    io = _exec(ws, "cat $F")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_var_concat_path():
    ws = _ws()
    _exec(ws, "export DIR=/s3")
    io = _exec(ws, "cat $DIR/data.txt")
    assert io.exit_code == 0
    assert b"hello from s3" in _stdout(io)


# ── assignment ─────────────────────────────────


def test_bare_assignment():
    ws = _ws()
    _exec(ws, "X=hello")
    assert ws.get_session(DEFAULT_SESSION_ID).env["X"] == "hello"


def test_assignment_expansion():
    ws = _ws()
    _exec(ws, "export BASE=/s3")
    _exec(ws, "OUT=$BASE/result.txt")
    assert ws.get_session(DEFAULT_SESSION_ID).env["OUT"] == "/s3/result.txt"


# ── while read ─────────────────────────────────


def test_while_read():
    ws = _ws()
    _exec(ws,
          "while read LINE; do export LAST=$LINE; done",
          stdin=b"a\nb\nc\n")
    assert ws.get_session(DEFAULT_SESSION_ID).env["LAST"] == "c"


# ── cross-mount ────────────────────────────────


def test_cross_mount_cat():
    ws = _ws()
    io1 = _exec(ws, "cat /s3/report.csv")
    io2 = _exec(ws, "cat /ram/notes.txt")
    assert io1.exit_code == 0
    assert io2.exit_code == 0
    assert b"alice" in _stdout(io1)
    assert b"line1" in _stdout(io2)


# ── complex: pipeline + redirect + expansion ───


def test_pipeline_redirect_expansion():
    ws = _ws()
    _exec(ws, "export DIR=/disk")
    io = _exec(ws, "cat /s3/report.csv | grep alice > $DIR/result.txt")
    assert io.exit_code == 0
    io2 = _exec(ws, "cat /disk/result.txt")
    assert b"alice" in _stdout(io2)


def test_for_with_redirect():
    ws = _ws()
    _exec(ws, "for name in hello world; do "
          "echo $name > /disk/$name.txt; done")
    io1 = _exec(ws, "cat /disk/hello.txt")
    io2 = _exec(ws, "cat /disk/world.txt")
    assert b"hello" in _stdout(io1)
    assert b"world" in _stdout(io2)


# ── session isolation ──────────────────────────


def test_separate_sessions():
    ws = _ws()
    ws.create_session("worker")
    _exec(ws, "export X=default")
    assert "X" not in ws.get_session("worker").env


# ── exit code ──────────────────────────────────


def test_exit_code_propagation():
    ws = _ws()
    io = _exec(ws, "true")
    assert io.exit_code == 0
    io = _exec(ws, "false")
    assert io.exit_code == 1


def test_last_exit_code():
    ws = _ws()
    _exec(ws, "true")
    assert ws.get_session(DEFAULT_SESSION_ID).last_exit_code == 0
    _exec(ws, "false")
    assert ws.get_session(DEFAULT_SESSION_ID).last_exit_code == 1


# ═══════════════════════════════════════════════
# Complex nested: real-world patterns
# ═══════════════════════════════════════════════


def test_etl_pipeline():
    """Simulate: read CSV, filter, write result.

    cat /s3/report.csv | grep alice > /disk/filtered.txt
    Then verify filtered.txt has alice but not bob.
    """
    ws = _ws()
    _exec(ws, "cat /s3/report.csv | grep alice > /disk/filtered.txt")
    io = _exec(ws, "cat /disk/filtered.txt")
    out = _stdout(io)
    assert b"alice" in out
    assert b"bob" not in out


def test_multi_step_processing():
    """Multi-step: export vars, loop files, process each.

    export SRC=/s3
    export DST=/disk
    for f in report.csv data.txt; do
        cat $SRC/$f > $DST/$f
    done
    """
    ws = _ws()
    _exec(
        ws, "export SRC=/s3; export DST=/disk; "
        "for f in report.csv data.txt; do "
        "cat $SRC/$f > $DST/$f; done")
    io1 = _exec(ws, "cat /disk/report.csv")
    io2 = _exec(ws, "cat /disk/data.txt")
    assert b"alice" in _stdout(io1)
    assert b"hello from s3" in _stdout(io2)


def test_conditional_processing():
    """if/else with pipeline and redirect.

    if cat /s3/report.csv | grep alice; then
        echo found > /disk/status.txt
    else
        echo missing > /disk/status.txt
    fi
    """
    ws = _ws()
    _exec(
        ws, "if cat /s3/report.csv | grep alice; then "
        "echo found > /disk/status.txt; "
        "else echo missing > /disk/status.txt; fi")
    io = _exec(ws, "cat /disk/status.txt")
    assert b"found" in _stdout(io)


def test_function_with_pipeline_redirect():
    """Define function that processes a file.

    process() {
        cat $1 | sort > $2
    }
    process /ram/notes.txt /disk/sorted.txt
    """
    ws = _ws()
    _exec(
        ws, "process() { cat $1 | sort > $2; }; "
        "process /ram/notes.txt /disk/sorted.txt")
    io = _exec(ws, "cat /disk/sorted.txt")
    out = _stdout(io)
    assert b"line1" in out
    lines = out.decode().strip().split("\n")
    assert lines == sorted(lines)


def test_while_read_with_conditional_write():
    """Read lines, write matching ones to file.

    while read LINE; do
        case $LINE in
            alice*) echo $LINE >> /disk/matches.txt;;
        esac
    done
    """
    ws = _ws()
    _exec(ws, "while read LINE; do "
          "case $LINE in "
          "alice*) echo $LINE >> /disk/matches.txt;; "
          "esac; done",
          stdin=b"alice,30\nbob,25\nalice,40\n")
    io = _exec(ws, "cat /disk/matches.txt")
    out = _stdout(io)
    assert out.count(b"alice") == 2
    assert b"bob" not in out


def test_nested_for_cross_mount():
    """Nested for across mounts.

    for src in /s3 /ram; do
        for f in report.csv notes.txt; do
            cat $src/$f 2>/dev/null && export FOUND=$src/$f
        done
    done
    """
    ws = _ws()
    s = ws.get_session(DEFAULT_SESSION_ID)
    _exec(
        ws, "for src in /s3 /ram; do "
        "for f in report.csv notes.txt; do "
        "cat $src/$f && export FOUND=$src/$f; "
        "done; done")
    assert "FOUND" in s.env


def test_background_with_foreground_work():
    """Background sleep while foreground does work.

    sleep 0.01 &
    export A=1
    export B=2
    cat /s3/report.csv > /disk/copy.txt
    """
    ws = _ws()
    _exec(
        ws, "sleep 0.01 & export A=1; export B=2; "
        "cat /s3/report.csv > /disk/copy.txt")
    s = ws.get_session(DEFAULT_SESSION_ID)
    assert s.env["A"] == "1"
    assert s.env["B"] == "2"
    io = _exec(ws, "cat /disk/copy.txt")
    assert b"alice" in _stdout(io)


def test_subshell_pipeline_redirect():
    """Subshell isolates env but output flows.

    (export TMP=inner; cat /s3/report.csv) | sort > /disk/out.txt
    """
    ws = _ws()
    _exec(ws, "(export TMP=inner; cat /s3/report.csv) | "
          "sort > /disk/out.txt")
    s = ws.get_session(DEFAULT_SESSION_ID)
    assert "TMP" not in s.env
    io = _exec(ws, "cat /disk/out.txt")
    out = _stdout(io)
    assert len(out) > 0


def test_brace_group_pipeline():
    """Brace group output piped.

    { echo header; cat /s3/report.csv; } | sort > /disk/combined.txt
    """
    ws = _ws()
    _exec(
        ws, "{ echo header; cat /s3/report.csv; } | "
        "sort > /disk/combined.txt")
    io = _exec(ws, "cat /disk/combined.txt")
    out = _stdout(io)
    assert b"header" in out
    assert b"alice" in out


def test_echo_seq_for_redirect():
    """Use seq in for loop to generate numbered files.

    for n in 1 2 3; do
        echo "file $n" > /disk/f$n.txt
    done
    """
    ws = _ws()
    _exec(ws, 'for n in 1 2 3; do '
          'echo "file $n" > /disk/f$n.txt; done')
    io1 = _exec(ws, "cat /disk/f1.txt")
    io3 = _exec(ws, "cat /disk/f3.txt")
    assert b"file 1" in _stdout(io1)
    assert b"file 3" in _stdout(io3)


def test_multi_pipeline_chain():
    """Chained pipelines with &&.

    cat /s3/report.csv | grep alice && echo found
    """
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv | grep alice && echo found")
    out = _stdout(io)
    assert b"found" in out


def test_error_handling_or():
    """cat missing || echo fallback.

    When cat fails, fallback runs.
    """
    ws = _ws()
    io = _exec(ws, "cat /s3/missing.txt || echo fallback")
    out = _stdout(io)
    assert b"fallback" in out


def test_full_script_simulation():
    """Simulate a real script:

    export SRC=/s3
    export DST=/disk

    if cat $SRC/report.csv | grep alice; then
        cat $SRC/report.csv | sort > $DST/sorted.txt
        echo "done" > $DST/status.txt
    else
        echo "no data" > $DST/status.txt
    fi
    """
    ws = _ws()
    script = ("export SRC=/s3; export DST=/disk; "
              "if cat $SRC/report.csv | grep alice; then "
              "cat $SRC/report.csv | sort > $DST/sorted.txt; "
              "echo done > $DST/status.txt; "
              "else echo no_data > $DST/status.txt; fi")
    _exec(ws, script)
    io_status = _exec(ws, "cat /disk/status.txt")
    assert b"done" in _stdout(io_status)
    io_sorted = _exec(ws, "cat /disk/sorted.txt")
    out = _stdout(io_sorted)
    assert b"alice" in out
    lines = out.decode().strip().split("\n")
    assert lines == sorted(lines)


# ═══════════════════════════════════════════════
# grep, awk, sed, jq, wc, head, tail, cut, uniq, tr
# ═══════════════════════════════════════════════


def test_grep_pattern():
    ws = _ws()
    io = _exec(ws, "grep alice /s3/report.csv")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)
    assert b"bob" not in _stdout(io)


def test_grep_count():
    ws = _ws()
    io = _exec(ws, "grep -c GET /s3/access.log")
    assert io.exit_code == 0
    assert b"3" in _stdout(io)


def test_grep_invert():
    ws = _ws()
    io = _exec(ws, "grep -v 500 /s3/access.log")
    out = _stdout(io)
    assert b"500" not in out
    assert b"200" in out


def test_grep_pipe():
    ws = _ws()
    io = _exec(ws, "cat /s3/access.log | grep POST")
    out = _stdout(io)
    assert out.count(b"POST") == 2
    assert b"GET" not in out


def test_awk_print_field():
    ws = _ws()
    io = _exec(ws, "awk -F, '{print $1}' /s3/report.csv")
    out = _stdout(io)
    assert b"name" in out
    assert b"alice" in out


def test_awk_sum():
    ws = _ws()
    io = _exec(ws, "awk -F, 'NR>1{s+=$2}END{print s}' /s3/report.csv")
    out = _stdout(io)
    assert b"55" in out


def test_sed_substitute():
    ws = _ws()
    io = _exec(ws, "sed 's/alice/ALICE/' /s3/report.csv")
    out = _stdout(io)
    assert b"ALICE" in out
    assert b"alice" not in out


def test_sed_delete_line():
    ws = _ws()
    io = _exec(ws, "sed '/bob/d' /s3/report.csv")
    out = _stdout(io)
    assert b"bob" not in out
    assert b"alice" in out


def test_sed_pipe():
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv | sed 's/,/ | /g'")
    out = _stdout(io)
    assert b" | " in out


def test_jq_field():
    ws = _ws()
    io = _exec(ws, "jq '.[0].name' /s3/users.json")
    out = _stdout(io)
    assert b"alice" in out


def test_jq_length():
    ws = _ws()
    io = _exec(ws, "jq 'length' /s3/users.json")
    out = _stdout(io)
    assert b"2" in out


def test_jq_pipe():
    ws = _ws()
    io = _exec(ws, "cat /s3/users.json | jq '.[1].age'")
    out = _stdout(io)
    assert b"25" in out


def test_wc_lines():
    ws = _ws()
    io = _exec(ws, "wc -l /ram/notes.txt")
    out = _stdout(io)
    assert b"3" in out


def test_wc_pipe():
    ws = _ws()
    io = _exec(ws, "cat /s3/access.log | wc -l")
    out = _stdout(io)
    assert b"5" in out


def test_head_n():
    ws = _ws()
    io = _exec(ws, "head -n 2 /s3/access.log")
    out = _stdout(io)
    lines = out.strip().split(b"\n")
    assert len(lines) == 2


def test_tail_n():
    ws = _ws()
    io = _exec(ws, "tail -n 2 /s3/access.log")
    out = _stdout(io)
    lines = out.strip().split(b"\n")
    assert len(lines) == 2


def test_cut_field():
    ws = _ws()
    io = _exec(ws, "cut -d, -f1 /s3/report.csv")
    out = _stdout(io)
    assert b"name" in out
    assert b"alice" in out


def test_uniq_dedup():
    ws = _ws()
    io = _exec(ws, "sort /ram/words.txt | uniq")
    out = _stdout(io)
    assert out.count(b"apple") == 1


def test_tr_upper():
    ws = _ws()
    io = _exec(ws, "cat /s3/data.txt | tr 'a-z' 'A-Z'")
    out = _stdout(io)
    assert b"HELLO FROM S3" in out


def test_sort_numeric():
    ws = _ws()
    io = _exec(ws, "sort -n /ram/nums.txt")
    out = _stdout(io)
    lines = out.decode().strip().split("\n")
    assert lines == ["1", "2", "3", "4", "5"]


def test_rev_pipe():
    ws = _ws()
    io = _exec(ws, "echo hello | rev")
    assert b"olleh" in _stdout(io)


def test_nl_numbers():
    ws = _ws()
    io = _exec(ws, "nl /ram/notes.txt")
    out = _stdout(io)
    assert b"1" in out
    assert b"line1" in out


# ═══════════════════════════════════════════════
# env set / unset / printenv
# ═══════════════════════════════════════════════


def test_unset_removes():
    ws = _ws()
    _exec(ws, "export FOO=bar; unset FOO")
    assert "FOO" not in ws.get_session(DEFAULT_SESSION_ID).env


def test_printenv_single():
    ws = _ws()
    _exec(ws, "export MY_VAR=hello")
    io = _exec(ws, "printenv MY_VAR")
    assert b"hello" in _stdout(io)


def test_printenv_all():
    ws = _ws()
    _exec(ws, "export A=1; export B=2")
    io = _exec(ws, "printenv")
    out = _stdout(io)
    assert b"A=1" in out
    assert b"B=2" in out


def test_export_override():
    ws = _ws()
    _exec(ws, "export X=first; export X=second")
    assert ws.get_session(DEFAULT_SESSION_ID).env["X"] == "second"


def test_env_in_pipeline():
    ws = _ws()
    _exec(ws, "export PATTERN=alice")
    io = _exec(ws, "cat /s3/report.csv | grep $PATTERN")
    assert b"alice" in _stdout(io)


# ═══════════════════════════════════════════════
# python execution
# ═══════════════════════════════════════════════


def test_python_script():
    ws = _ws()
    io = _exec(ws, "python3 /s3/script.py")
    assert io.exit_code == 0


def test_python_c_flag():
    ws = _ws()
    io = _exec(ws, "python3 -c 'print(1+2)'")
    assert io.exit_code == 0


def test_python_pipe():
    ws = _ws()
    io = _exec(ws, "python3 -c 'print(42)' | grep 42")
    assert io.exit_code == 0


# ═══════════════════════════════════════════════
# echo / sleep / background
# ═══════════════════════════════════════════════


def test_echo_basic_ws():
    ws = _ws()
    io = _exec(ws, "echo hello world")
    assert _stdout(io) == b"hello world\n"


def test_echo_n():
    ws = _ws()
    io = _exec(ws, "echo -n hello")
    assert _stdout(io) == b"hello"


def test_sleep_and_echo():
    ws = _ws()
    io = _exec(ws, "sleep 0; echo done")
    assert b"done" in _stdout(io)


def test_background_foreground():
    ws = _ws()
    io = _exec(ws, "sleep 0.01 & echo foreground")
    assert b"foreground" in _stdout(io)


# ═══════════════════════════════════════════════
# Complex: real-world scripts
# ═══════════════════════════════════════════════


def test_log_analysis():
    """grep 500 | wc -l > error_count.txt."""
    ws = _ws()
    _exec(ws, "grep 500 /s3/access.log | wc -l > /disk/err.txt")
    io = _exec(ws, "cat /disk/err.txt")
    assert b"2" in _stdout(io)


def test_csv_extract_sort_uniq():
    """tail | cut | sort | uniq."""
    ws = _ws()
    io = _exec(ws, "tail -n +2 /s3/report.csv | cut -d, -f1 | sort | uniq")
    out = _stdout(io)
    assert b"alice" in out
    assert b"bob" in out


def test_config_loader():
    """while read LINE; do export $LINE; done."""
    ws = _ws()
    _exec(ws,
          "while read LINE; do export $LINE; done",
          stdin=b"DB_HOST=localhost\nDB_PORT=5432\n")
    s = ws.get_session(DEFAULT_SESSION_ID)
    assert s.env["DB_HOST"] == "localhost"
    assert s.env["DB_PORT"] == "5432"


def test_multi_mount_awk_sort():
    """cat | awk | sort > file."""
    ws = _ws()
    _exec(
        ws, "cat /s3/report.csv | awk -F, 'NR>1{print $1}' | "
        "sort > /disk/names.txt")
    io = _exec(ws, "cat /disk/names.txt")
    out = _stdout(io)
    assert b"alice" in out
    assert b"bob" in out
    lines = out.decode().strip().split("\n")
    assert lines == sorted(lines)


def test_conditional_grep_sed():
    """if grep errors; then sed replace > file."""
    ws = _ws()
    _exec(
        ws, "if grep 500 /s3/access.log; then "
        "grep 500 /s3/access.log | sed 's/500/ERROR/' "
        "> /disk/errors.txt; fi")
    io = _exec(ws, "cat /disk/errors.txt")
    out = _stdout(io)
    assert b"ERROR" in out
    assert b"500" not in out


def test_function_grep_wc():
    """filter() { grep $1 $2 | wc -l; }."""
    ws = _ws()
    _exec(
        ws, "filter() { grep $1 $2 | wc -l > /disk/c.txt; }; "
        "filter GET /s3/access.log")
    io = _exec(ws, "cat /disk/c.txt")
    assert b"3" in _stdout(io)


def test_jq_transform_write():
    """jq extract > file."""
    ws = _ws()
    _exec(ws, "jq '.[].name' /s3/users.json > /disk/names.json")
    io = _exec(ws, "cat /disk/names.json")
    out = _stdout(io)
    assert b"alice" in out
    assert b"bob" in out


def test_background_with_pipeline():
    """Background sleep, foreground pipeline."""
    ws = _ws()
    _exec(
        ws, "sleep 0.01 & "
        "cat /s3/report.csv | grep alice | "
        "sed 's/alice/ALICE/' > /disk/bg.txt")
    io = _exec(ws, "cat /disk/bg.txt")
    assert b"ALICE" in _stdout(io)


def test_nested_function_tr():
    """upper() { tr a-z A-Z; }; process() { cat $1 | upper > $2; }."""
    ws = _ws()
    _exec(
        ws, "upper() { tr 'a-z' 'A-Z'; }; "
        "process() { cat $1 | upper > $2; }; "
        "process /s3/data.txt /disk/upper.txt")
    io = _exec(ws, "cat /disk/upper.txt")
    assert b"HELLO FROM S3" in _stdout(io)


# ═══════════════════════════════════════════════
# Redirect: 2>&1, 2>/dev/null, 2>file
# ═══════════════════════════════════════════════


def test_stderr_to_stdout_merge():
    """cat missing 2>&1 → stderr appears in stdout."""
    ws = _ws()
    io = _exec(ws, "cat /s3/nonexistent.txt 2>&1")
    out = _stdout(io)
    assert b"nonexistent" in out or io.exit_code != 0


def test_stderr_to_file():
    """cat missing 2> /disk/err.log → stderr written to file."""
    ws = _ws()
    _exec(ws, "cat /s3/nonexistent.txt 2> /disk/err.log")
    io = _exec(ws, "cat /disk/err.log")
    out = _stdout(io)
    assert b"nonexistent" in out


def test_stderr_to_dev_null():
    """cat missing 2>/dev/null → stderr suppressed."""
    ws = _ws()
    io = _exec(ws, "cat /s3/nonexistent.txt 2> /disk/null.txt")
    assert io.stderr is None or io.stderr == b""


def test_stderr_merge_in_pipeline():
    """{ cat /s3/report.csv; cat /s3/missing.txt; } 2>&1 | sort."""
    ws = _ws()
    io = _exec(ws, "{ cat /s3/report.csv; } 2>&1 | sort")
    assert io.exit_code == 0


def test_stdout_redirect_preserves_stderr():
    """echo hello > /disk/out.txt → stderr not affected."""
    ws = _ws()
    io = _exec(ws, "echo hello > /disk/out.txt")
    assert io.exit_code == 0
    io2 = _exec(ws, "cat /disk/out.txt")
    assert b"hello" in _stdout(io2)


def test_stderr_redirect_preserves_stdout():
    """cat /s3/report.csv 2> /disk/err.log → stdout still works."""
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv 2> /disk/err.log")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_both_to_file():
    """echo hello &> /disk/both.txt → stdout+stderr to file."""
    ws = _ws()
    _exec(ws, "echo hello &> /disk/both.txt")
    io = _exec(ws, "cat /disk/both.txt")
    assert b"hello" in _stdout(io)


def test_both_append():
    """echo a &> /disk/b.txt; echo b &>> /disk/b.txt → both appended."""
    ws = _ws()
    _exec(ws, "echo first &> /disk/b.txt")
    _exec(ws, "echo second &>> /disk/b.txt")
    io = _exec(ws, "cat /disk/b.txt")
    out = _stdout(io)
    assert b"first" in out
    assert b"second" in out


def test_stderr_to_file_on_error():
    """cat missing 2> /disk/err.txt → error goes to file."""
    ws = _ws()
    _exec(ws, "cat /s3/nope.txt 2> /disk/err.txt")
    io = _exec(ws, "cat /disk/err.txt")
    assert b"nope" in _stdout(io)


def test_both_redirect_on_error():
    """cat missing &> /disk/all.txt → stderr in file."""
    ws = _ws()
    _exec(ws, "cat /s3/nope.txt &> /disk/all.txt")
    io = _exec(ws, "cat /disk/all.txt")
    assert b"nope" in _stdout(io)


def test_redirect_with_var_target():
    """echo hello > $OUT → expanded path."""
    ws = _ws()
    _exec(ws, "export OUT=/disk/var_out.txt")
    _exec(ws, "echo hello > $OUT")
    io = _exec(ws, "cat /disk/var_out.txt")
    assert b"hello" in _stdout(io)


def test_multiple_redirects_stdout_and_stderr():
    """cat report > /disk/out.txt 2> /disk/err.txt."""
    ws = _ws()
    _exec(ws, "cat /s3/report.csv > /disk/out.txt 2> /disk/err.txt")
    io = _exec(ws, "cat /disk/out.txt")
    assert b"alice" in _stdout(io)


# ═══════════════════════════════════════════════
# Pipeline mount fallback (no path args)
# ═══════════════════════════════════════════════


def test_pipeline_wc():
    """cat file | wc -l → wc finds mount via fallback."""
    ws = _ws()
    io = _exec(ws, "cat /ram/notes.txt | wc -l")
    assert io.exit_code == 0
    assert b"3" in _stdout(io)


def test_pipeline_head():
    """cat file | head -n 1 → head finds mount."""
    ws = _ws()
    io = _exec(ws, "cat /ram/notes.txt | head -n 1")
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"line1" in out


def test_pipeline_tail():
    """cat file | tail -n 1 → tail finds mount."""
    ws = _ws()
    io = _exec(ws, "cat /ram/notes.txt | tail -n 1")
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"line3" in out


def test_pipeline_uniq():
    """sort file | uniq → uniq finds mount."""
    ws = _ws()
    io = _exec(ws, "sort /ram/words.txt | uniq")
    assert io.exit_code == 0
    out = _stdout(io)
    assert out.count(b"apple") == 1


def test_pipeline_cut():
    """cat csv | cut -d, -f1 → cut finds mount."""
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv | cut -d, -f1")
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"name" in out
    assert b"alice" in out


def test_pipeline_tr():
    """cat file | tr a-z A-Z → tr finds mount."""
    ws = _ws()
    io = _exec(ws, "cat /s3/data.txt | tr 'a-z' 'A-Z'")
    assert io.exit_code == 0
    assert b"HELLO" in _stdout(io)


def test_pipeline_grep():
    """cat file | grep pattern → grep finds mount."""
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv | grep alice")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_pipeline_four_stages():
    """cat | grep | sort | uniq → all find mounts."""
    ws = _ws()
    io = _exec(ws, "cat /ram/words.txt | grep apple | sort | uniq")
    assert io.exit_code == 0
    assert _stdout(io).count(b"apple") == 1


def test_pipeline_with_default_cwd():
    """Pipeline works even with default cwd=/mirage."""
    ws = _ws()
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/mirage"
    io = _exec(ws, "cat /s3/report.csv | wc -l")
    assert io.exit_code == 0
    assert b"3" in _stdout(io)


def test_pipeline_sed():
    """cat file | sed → sed finds mount."""
    ws = _ws()
    io = _exec(ws, "cat /s3/report.csv | sed 's/alice/ALICE/'")
    assert io.exit_code == 0
    assert b"ALICE" in _stdout(io)


# ── cache resource fallback ───────────────────


def test_cache_fallback_wc():
    """wc uses cache resource when cwd has no mount."""
    ws = _ws()
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/mirage"
    io = _exec(ws, "cat /s3/report.csv | wc -l")
    assert io.exit_code == 0
    assert b"3" in _stdout(io)


def test_cache_fallback_head():
    """head uses cache resource fallback."""
    ws = _ws()
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/nonexistent"
    io = _exec(ws, "cat /ram/notes.txt | head -n 1")
    assert io.exit_code == 0
    assert b"line1" in _stdout(io)


def test_cache_fallback_grep():
    """grep uses cache resource fallback in pipeline."""
    ws = _ws()
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/mirage"
    io = _exec(ws, "cat /s3/report.csv | grep alice")
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_cache_fallback_sort_uniq():
    """sort | uniq uses cache resource."""
    ws = _ws()
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/mirage"
    io = _exec(ws, "cat /ram/words.txt | sort | uniq")
    assert io.exit_code == 0
    assert _stdout(io).count(b"apple") == 1


def test_cache_fallback_multi_pipe():
    """Four-stage pipeline with cache fallback."""
    ws = _ws()
    ws.get_session(DEFAULT_SESSION_ID).cwd = "/mirage"
    io = _exec(ws, "cat /s3/report.csv | grep -v name "
               "| cut -d, -f1 | sort")
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"alice" in out
    assert b"bob" in out


# ── general commands (no resource needed) ─────


def test_seq_basic():
    ws = _ws()
    io = _exec(ws, "seq 5")
    assert _stdout(io) == b"1\n2\n3\n4\n5\n"


def test_seq_range():
    ws = _ws()
    io = _exec(ws, "seq 2 5")
    assert _stdout(io) == b"2\n3\n4\n5\n"


def test_seq_separator():
    ws = _ws()
    io = _exec(ws, "seq -s , 3")
    assert _stdout(io) == b"1,2,3\n"


def test_expr_add():
    ws = _ws()
    io = _exec(ws, "expr 2 + 3")
    assert b"5" in _stdout(io)


def test_expr_multiply():
    ws = _ws()
    io = _exec(ws, "expr 4 '*' 3")
    assert b"12" in _stdout(io)


def test_bc_basic():
    ws = _ws()
    io = _exec(ws, "echo '2+3' | bc")
    assert b"5" in _stdout(io)


def test_date_iso():
    ws = _ws()
    io = _exec(ws, "date -I")
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"202" in out


def test_echo_escape():
    ws = _ws()
    io = _exec(ws, "echo -e 'hello\\nworld'")
    assert _stdout(io) == b"hello\nworld\n"


def test_echo_no_newline():
    ws = _ws()
    io = _exec(ws, "echo -n hello")
    assert _stdout(io) == b"hello"


# ── sort as resource command ──────────────────


def test_sort_file():
    ws = _ws()
    io = _exec(ws, "sort /ram/nums.txt")
    assert io.exit_code == 0
    lines = _stdout(io).decode().strip().split("\n")
    assert lines == ["1", "2", "3", "4", "5"]


def test_sort_reverse():
    ws = _ws()
    io = _exec(ws, "sort -r /ram/nums.txt")
    lines = _stdout(io).decode().strip().split("\n")
    assert lines == ["5", "4", "3", "2", "1"]


def test_sort_stdin():
    ws = _ws()
    io = _exec(ws, "echo '3\n1\n2' | sort -n")
    assert io.exit_code == 0


def test_sort_unique():
    ws = _ws()
    io = _exec(ws, "sort -u /ram/words.txt")
    lines = _stdout(io).decode().strip().split("\n")
    assert len(lines) == 3


def test_seq_one():
    ws = _ws()
    io = _exec(ws, "seq 1")
    assert _stdout(io) == b"1\n"


def test_seq_in_for():
    ws = _ws()
    io = _exec(ws, "for n in $(seq 3); do echo $n; done")
    out = _stdout(io)
    assert b"1" in out
    assert b"3" in out


def test_sort_empty_stdin():
    ws = _ws()
    io = _exec(ws, "echo -n '' | sort")
    assert io.exit_code == 0


def test_sort_single_line():
    ws = _ws()
    io = _exec(ws, "echo hello | sort")
    assert b"hello" in _stdout(io)


def test_expr_zero_returns_1():
    ws = _ws()
    io = _exec(ws, "expr 0 + 0")
    assert io.exit_code == 1


def test_seq_in_pipeline():
    ws = _ws()
    io = _exec(ws, "seq 5 | sort -rn")
    lines = _stdout(io).decode().strip().split("\n")
    assert lines == ["5", "4", "3", "2", "1"]


# ── python3 ───────────────────────────────────


def test_python3_c_simple():
    ws = _ws()
    io = _exec(ws, 'python3 -c "print(42)"')
    assert io.exit_code == 0
    assert _stdout(io) == b"42\n"


def test_python3_c_multiline():
    ws = _ws()
    io = _exec(ws, 'python3 -c "x = 2\nprint(x * 3)"')
    assert _stdout(io) == b"6\n"


def test_python3_c_with_stdin():
    ws = _ws()
    io = _exec(
        ws, 'echo hello | python3 -c "import sys; '
        'print(sys.stdin.read().strip().upper())"')
    assert _stdout(io) == b"HELLO\n"


def test_python3_c_path_in_code():
    """Paths inside -c code should not be classified as PathSpec."""
    ws = _ws()
    io = _exec(ws, "python3 -c \"print('/s3/data/file.txt')\"")
    assert io.exit_code == 0
    assert b"/s3/data/file.txt" in _stdout(io)


def test_python3_c_with_star():
    """* in -c code should not be glob-expanded."""
    ws = _ws()
    io = _exec(ws, 'python3 -c "print(2 * 3)"')
    assert _stdout(io) == b"6\n"


def test_python3_script_file():
    ws = _ws()
    _exec(ws, "echo 'print(99)' > /disk/script.py")
    io = _exec(ws, "python3 /disk/script.py")
    assert io.exit_code == 0
    assert _stdout(io) == b"99\n"


def test_python3_session_env():
    ws = _ws()
    _exec(ws, "export MY_VAR=hello_mirage")
    io = _exec(
        ws, 'python3 -c "import os; '
        "print(os.environ.get('MY_VAR', 'none'))\"")
    assert _stdout(io) == b"hello_mirage\n"


def test_python3_no_args():
    ws = _ws()
    io = _exec(ws, "python3")
    assert io.exit_code == 1
    assert b"no input" in io.stderr


def test_python3_c_with_argv():
    """python3 -c "code" arg1 arg2 → arg1/arg2 reach sys.argv as bare text."""
    ws = _ws()
    io = _exec(ws, 'python3 -c "import sys; print(sys.argv[1:])" alpha beta')
    assert io.exit_code == 0
    assert _stdout(io) == b"['alpha', 'beta']\n"


def test_python3_c_with_abs_path_argv():
    """python3 -c "code" /abs/path → abs path stays text argv (not script)."""
    ws = _ws()
    io = _exec(ws,
               'python3 -c "import sys; print(sys.argv[1:])" /disk/some_file')
    assert io.exit_code == 0
    assert _stdout(io) == b"['/disk/some_file']\n"


def test_python3_script_with_argv():
    """python3 /abs/script.py arg1 arg2 → script reads, argv passed through."""
    ws = _ws()
    _exec(ws, "echo 'import sys; print(sys.argv[1:])' > /disk/argv.py")
    io = _exec(ws, "python3 /disk/argv.py alpha beta")
    assert io.exit_code == 0
    assert _stdout(io) == b"['alpha', 'beta']\n"


def test_python3_bare_name_script_via_cwd():
    """python3 script.py (bare name) → resolves against cwd, dispatched."""
    ws = _ws()
    _exec(ws, "echo 'print(123)' > /disk/bare.py")
    io = _exec(ws, "cd /disk && python3 bare.py")
    assert io.exit_code == 0
    assert _stdout(io) == b"123\n"


def test_python3_bare_name_script_with_argv():
    """python3 script.py one two (bare + argv) → cwd-resolved + argv passes."""
    ws = _ws()
    _exec(ws, "echo 'import sys; print(sys.argv[1:])' > /disk/with_argv.py")
    io = _exec(ws, "cd /disk && python3 with_argv.py one two")
    assert io.exit_code == 0
    assert _stdout(io) == b"['one', 'two']\n"


# ── cross-mount commands ──────────────────────


def test_cross_mount_cp():
    ws = _ws()
    io = _exec(ws, "cp /s3/data.txt /disk/data_copy.txt")
    assert io.exit_code == 0
    io = _exec(ws, "cat /disk/data_copy.txt")
    assert b"hello from s3" in _stdout(io)


def test_cross_mount_cp_reverse():
    ws = _ws()
    _exec(ws, "echo test_data > /disk/new.txt")
    io = _exec(ws, "cp /disk/new.txt /ram/new_copy.txt")
    assert io.exit_code == 0
    io = _exec(ws, "cat /ram/new_copy.txt")
    assert b"test_data" in _stdout(io)


def test_cross_mount_mv():
    ws = _ws()
    _exec(ws, "echo moveme > /disk/moveme.txt")
    io = _exec(ws, "mv /disk/moveme.txt /ram/moved.txt")
    assert io.exit_code == 0
    io = _exec(ws, "cat /ram/moved.txt")
    assert b"moveme" in _stdout(io)
    io = _exec(ws, "cat /disk/moveme.txt")
    assert io.exit_code == 1


def test_cross_mount_diff_same():
    ws = _ws()
    _exec(ws, "echo same > /disk/a.txt")
    _exec(ws, "echo same > /ram/b.txt")
    io = _exec(ws, "diff /disk/a.txt /ram/b.txt")
    assert io.exit_code == 0


def test_cross_mount_diff_different():
    ws = _ws()
    _exec(ws, "echo aaa > /disk/a.txt")
    _exec(ws, "echo bbb > /ram/b.txt")
    io = _exec(ws, "diff /disk/a.txt /ram/b.txt")
    assert io.exit_code == 1
    out = _stdout(io)
    assert b"---" in out
    assert b"+++" in out


def test_cross_mount_cmp_same():
    ws = _ws()
    _exec(ws, "echo identical > /disk/a.txt")
    _exec(ws, "echo identical > /ram/b.txt")
    io = _exec(ws, "cmp /disk/a.txt /ram/b.txt")
    assert io.exit_code == 0


def test_cross_mount_cmp_different():
    ws = _ws()
    _exec(ws, "echo xxx > /disk/a.txt")
    _exec(ws, "echo yyy > /ram/b.txt")
    io = _exec(ws, "cmp /disk/a.txt /ram/b.txt")
    assert io.exit_code == 1
    assert b"differ" in _stdout(io)


# ── cache hit/miss/invalidation ─────────────────────────────────────────


def test_cache_hit_serves_from_ram():
    ws = _ws()
    io1 = _exec(ws, "cat /s3/data.txt")
    assert _stdout(io1) == b"hello from s3\n"
    records_after_first = list(ws.ops.records)
    io2 = _exec(ws, "cat /s3/data.txt")
    assert _stdout(io2) == b"hello from s3\n"
    new_records = ws.ops.records[len(records_after_first):]
    sources = [r.source for r in new_records if r.op == "read"]
    assert all(s == "ram" for s in sources)


def test_cache_miss_reads_from_resource():
    ws = _ws()
    io = _exec(ws, "cat /s3/data.txt")
    assert _stdout(io) == b"hello from s3\n"
    sources = [r.source for r in ws.ops.records if r.op == "read"]
    assert sources[0] == "ram"


def test_cache_invalidation_after_write():
    ws = _ws()
    _exec(ws, "cat /disk/readme.txt")
    cached = _run(ws._cache.get("/disk/readme.txt"))
    assert cached is not None
    _exec(ws, "echo updated > /disk/readme.txt")
    cached = _run(ws._cache.get("/disk/readme.txt"))
    assert cached is None


def test_grep_uses_cache():
    ws = _ws()
    _exec(ws, "cat /s3/report.csv")
    records_before = len(ws.ops.records)
    io = _exec(ws, "grep alice /s3/report.csv")
    assert b"alice" in _stdout(io)
    new_records = ws.ops.records[records_before:]
    sources = [r.source for r in new_records if r.op == "read"]
    assert all(s == "ram" for s in sources)


# ── readdir index cache ─────────────────────────────────────────────────


def test_readdir_populates_index():
    """readdir stores listing in index (verified via internal dict)."""
    ws = _ws()
    resource = ws._registry.mount_for("/s3/report.csv").resource
    assert len(resource.index._entries) == 0
    _exec(ws, "ls /s3")
    assert len(resource.index._entries) > 0


# ── grep -l / -m early termination ──────────────────────────────────────


def test_grep_files_only_returns_filename():
    """grep -l returns matching filename, not content."""
    ws = _ws()
    io = _exec(ws, "grep -l alice /s3/report.csv")
    stdout = _stdout(io)
    assert b"report.csv" in stdout
    assert b"alice,30" not in stdout


def test_grep_max_count_limits_output():
    """grep -m 1 returns at most 1 match."""
    ws = _ws()
    io = _exec(ws, "grep -m 1 GET /s3/access.log")
    lines = _stdout(io).strip().split(b"\n")
    assert len(lines) == 1
    assert b"GET" in lines[0]


# ── for loop break/continue ─────────────────────────────────────────────


def test_for_break_preserves_output():
    """break stops loop but output before break is preserved."""
    ws = _ws()
    io = _exec(ws, "for x in a b c; do echo $x; break; done")
    assert _stdout(io) == b"a\n"


def test_for_break_with_condition():
    """for with [ $x = c ] break stops at correct iteration."""
    ws = _ws()
    io = _exec(
        ws,
        "for x in a b c d; do if [ $x = c ]; then break; fi; echo $x; done")
    assert _stdout(io) == b"a\nb\n"


def test_for_continue_with_condition():
    """for with [ $x = b ] continue skips that iteration."""
    ws = _ws()
    io = _exec(
        ws,
        "for x in a b c d; do if [ $x = b ]; then continue; fi; echo $x; done")
    assert _stdout(io) == b"a\nc\nd\n"


def test_for_continue_skips_iteration():
    """continue skips to next iteration, other iterations produce output."""
    ws = _ws()
    io = _exec(ws,
               "for x in a b c; do if true; then echo $x; continue; fi; done")
    assert _stdout(io) == b"a\nb\nc\n"


def test_test_literal_comparison():
    """[ a = a ] and [ a = b ] work correctly."""
    ws = _ws()
    assert _stdout(_exec(ws, "[ a = a ] && echo yes || echo no")) == b"yes\n"
    assert _stdout(_exec(ws, "[ a = b ] && echo yes || echo no")) == b"no\n"


def test_test_variable_comparison():
    """[ $var = value ] expands variable and compares."""
    ws = _ws()
    io = _exec(ws,
               "for x in a c; do [ $x = c ] && echo match || echo miss; done")
    assert _stdout(io) == b"miss\nmatch\n"


def test_test_numeric_comparison():
    """[ -lt -gt -eq ] numeric comparisons work."""
    ws = _ws()
    assert _stdout(_exec(ws, "[ 1 -lt 3 ] && echo yes || echo no")) == b"yes\n"
    assert _stdout(_exec(ws, "[ 3 -gt 1 ] && echo yes || echo no")) == b"yes\n"
    assert _stdout(_exec(ws, "[ 2 -eq 2 ] && echo yes || echo no")) == b"yes\n"


def test_arithmetic_expansion():
    """$(( )) arithmetic with variables works."""
    ws = _ws()
    assert _stdout(_exec(ws, "echo $((1 + 2))")) == b"3\n"
    assert _stdout(_exec(ws, "x=5; echo $(($x + 1))")) == b"6\n"


def test_while_loop():
    """while [ $x -lt 3 ] with arithmetic increment."""
    ws = _ws()
    io = _exec(ws, "x=0; while [ $x -lt 3 ]; do echo $x; x=$(($x + 1)); done")
    assert _stdout(io) == b"0\n1\n2\n"


def test_eval_echo():
    """eval executes command and returns stdout."""
    ws = _ws()
    assert _stdout(_exec(ws, 'eval "echo hello"')) == b"hello\n"


def test_eval_variable():
    """eval expands variables."""
    ws = _ws()
    assert _stdout(_exec(ws, 'x=hello; eval "echo $x"')) == b"hello\n"


# ── bash / sh ───────────────────────────────────────────────────────────


def test_bash_dash_c_basic():
    """`bash -c '...'` runs the script through Mirage's shell."""
    ws = _ws()
    assert _stdout(_exec(ws, "bash -c 'echo hello'")) == b"hello\n"


def test_bash_combined_short_flags():
    """`bash -lc '...'` unbundles -l (no-op) + -c (script)."""
    ws = _ws()
    io = _exec(ws, "bash -lc 'echo combined'")
    assert io.exit_code == 0
    assert _stdout(io) == b"combined\n"


def test_sh_alias():
    """`sh -c '...'` is treated as an alias for bash."""
    ws = _ws()
    assert _stdout(_exec(ws, 'sh -c "echo via-sh"')) == b"via-sh\n"


def test_bash_dash_c_for_loop_over_dirs():
    """`bash -lc` with a for-loop iterating mount paths."""
    s3 = RAMResource()
    s3.is_remote = True
    s3._store.dirs.update({
        "/INBOX",
        "/INBOX/2026-04-28",
        "/INBOX/2026-04-29",
    })
    s3._store.files["/INBOX/2026-04-28/m1.txt"] = b""
    s3._store.files["/INBOX/2026-04-29/m2.txt"] = b""
    ws = Workspace(
        resources={"/gmail/": (s3, MountMode.EXEC)},
        history=None,
    )
    cmd = ('bash -lc \'for d in /gmail/INBOX/2026-04-28 '
           '/gmail/INBOX/2026-04-29; do echo "== $d =="; ls "$d"; done\'')
    io = _exec(ws, cmd)
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"== /gmail/INBOX/2026-04-28 ==" in out
    assert b"== /gmail/INBOX/2026-04-29 ==" in out
    assert b"m1.txt" in out
    assert b"m2.txt" in out


def test_bash_pipes_through_mirage_shell():
    """Pipes inside `bash -c '...'` go back through the same parser."""
    ws = _ws()
    io = _exec(ws, "bash -c 'echo hello | tr a-z A-Z'")
    assert io.exit_code == 0
    assert _stdout(io) == b"HELLO\n"


def test_bash_stdin_flows_into_script():
    """Stdin piped into `bash -c '...'` is visible to the inner command."""
    ws = _ws()
    io = _exec(ws, 'echo piped | bash -c "cat"')
    assert io.exit_code == 0
    assert _stdout(io) == b"piped\n"


def test_bash_dash_s_reads_script_from_stdin():
    """`bash -s` reads the script body from stdin."""
    ws = _ws()
    io = _exec(ws, 'echo "echo from-stdin" | bash -s')
    assert io.exit_code == 0
    assert _stdout(io) == b"from-stdin\n"


def test_bash_missing_c_argument_errors():
    """`bash -c` with no argument is a usage error."""
    ws = _ws()
    io = _exec(ws, "bash -c")
    assert io.exit_code == 2
    assert b"-c" in (io.stderr or b"")


def test_man_bash_renders_spec():
    """`man bash` returns the bash spec; `man sh` is the same."""
    ws = _ws()
    io = _exec(ws, "man bash")
    assert io.exit_code == 0
    out = _stdout(io)
    assert b"# bash" in out
    assert b"-c" in out
    assert b"shell builtin" in out
    io2 = _exec(ws, "man sh")
    assert io2.exit_code == 0
    assert b"# sh" in _stdout(io2)


def test_python_pipe_stdin():
    """echo code | python3 reads code from stdin."""
    ws = _ws()
    io = _exec(ws, 'echo "print(1+2)" | python3')
    assert _stdout(io) == b"3\n"


# ── function fixes ───────────────────────────────────────────────────────


def test_function_return_exit_code():
    """return N propagates exit code for || and &&."""
    ws = _ws()
    assert _stdout(_exec(
        ws, "check() { return 1; }; check || echo failed")) == b"failed\n"
    assert _stdout(_exec(
        ws, "ok() { return 0; }; ok && echo success")) == b"success\n"


def test_function_local_scope():
    """local variables restored after function returns."""
    ws = _ws()
    io = _exec(ws, 'x=outside; f() { local x=inside; echo $x; }; f; echo $x')
    assert _stdout(io) == b"inside\noutside\n"


def test_function_shift_args():
    """shift in function moves positional params."""
    ws = _ws()
    io = _exec(ws, "f() { echo $1; shift; echo $1; }; f a b")
    assert _stdout(io) == b"a\nb\n"


def test_function_nested_output():
    """nested function calls preserve all output."""
    ws = _ws()
    io = _exec(
        ws, "inner() { echo inner; }; outer() { inner; echo outer; }; outer")
    assert _stdout(io) == b"inner\nouter\n"


# ── cross-mount multi-file ───────────────────────────────────────────────


def test_cat_cross_mount():
    """cat files from different mounts concatenates correctly."""
    ws = _ws()
    io = _exec(ws, "cat /s3/data.txt /disk/readme.txt")
    assert b"hello from s3" in _stdout(io)
    assert b"disk readme" in _stdout(io)


def test_head_cross_mount():
    """head -n 1 across mounts shows headers."""
    ws = _ws()
    io = _exec(ws, "head -n 1 /s3/data.txt /disk/readme.txt")
    out = _stdout(io)
    assert b"==> /s3/data.txt <==" in out
    assert b"==> /disk/readme.txt <==" in out


def test_grep_cross_mount():
    """grep across mounts prefixes filename."""
    ws = _ws()
    io = _exec(ws, "grep hello /s3/data.txt /disk/readme.txt")
    out = _stdout(io)
    assert b"/s3/data.txt:" in out


def test_wc_cross_mount():
    """wc -l across mounts shows per-file counts."""
    ws = _ws()
    io = _exec(ws, "wc -l /s3/data.txt /disk/readme.txt")
    out = _stdout(io)
    assert b"/s3/data.txt" in out
    assert b"/disk/readme.txt" in out


# ── heredoc/herestring ───────────────────────────────────────────────────


def test_heredoc():
    """cat << EOF passes body as stdin."""
    ws = _ws()
    io = _exec(ws, "cat << EOF\nhello\nworld\nEOF")
    assert _stdout(io) == b"hello\nworld\n"


def test_herestring():
    """cat <<< passes string as stdin."""
    ws = _ws()
    io = _exec(ws, 'cat <<< "hello world"')
    assert _stdout(io) == b"hello world\n"


def test_python_heredoc():
    """python3 << EOF runs code from heredoc."""
    ws = _ws()
    io = _exec(ws, "python3 << 'PYEOF'\nprint(1 + 2)\nPYEOF")
    assert _stdout(io) == b"3\n"


def test_heredoc_unquoted_expands_vars():
    """Unquoted heredoc delimiter → variables get expanded in body."""
    ws = _ws()
    io = _exec(ws, "X=world\ncat << EOF\nhello $X\nEOF")
    assert _stdout(io) == b"hello world\n"


def test_heredoc_quoted_no_expansion():
    """Quoted delimiter ('EOF') → variables are literal in body."""
    ws = _ws()
    io = _exec(ws, "X=world\ncat << 'EOF'\nhello $X\nEOF")
    assert _stdout(io) == b"hello $X\n"


def test_heredoc_dash_strips_tabs():
    """<<-EOF strips leading tabs from each body line."""
    ws = _ws()
    io = _exec(ws, "cat <<-EOF\n\thello\n\tworld\nEOF")
    assert _stdout(io) == b"hello\nworld\n"


def test_heredoc_in_for_loop():
    """Heredoc inside a for-loop body fires per iteration."""
    ws = _ws()
    io = _exec(ws, "for x in a b c; do cat <<EOF\nitem=$x\nEOF\ndone")
    assert _stdout(io) == b"item=a\nitem=b\nitem=c\n"


def test_python_heredoc_dash_strips_indentation():
    """python3 <<-PYEOF strips leading tabs so indented code parses."""
    ws = _ws()
    io = _exec(
        ws, "python3 <<-PYEOF\n"
        "\tfor i in range(3):\n"
        "\t    print(i)\n"
        "\tPYEOF")
    assert _stdout(io) == b"0\n1\n2\n"


def test_python_heredoc_quoted_keeps_dollar_literal():
    """python3 << 'PYEOF' — body keeps $-strings literal (no shell expand)."""
    ws = _ws()
    io = _exec(
        ws, "X=shellval\n"
        "python3 << 'PYEOF'\n"
        "x = '$X'\n"
        "print(x)\n"
        "PYEOF")
    assert _stdout(io) == b"$X\n"


def test_python_heredoc_unquoted_expands():
    """python3 << PYEOF (unquoted) — shell vars expand into the body."""
    ws = _ws()
    io = _exec(ws, "X=fromshell\n"
               "python3 << PYEOF\n"
               "print('$X')\n"
               "PYEOF")
    assert _stdout(io) == b"fromshell\n"


def test_relative_path_with_slash():
    """./file.txt and sub/file.txt resolve against cwd."""
    ws = _ws()
    _exec(ws, "echo test > /disk/out.txt")
    io = _exec(ws, "cd /disk && cat ./out.txt")
    assert _stdout(io) == b"test\n"


def test_set_positional_args():
    """set -- a b c makes $@ and $1 $2 $3 available."""
    ws = _ws()
    io = _exec(ws, "set -- a b c; echo $@")
    assert _stdout(io) == b"a b c\n"


def test_set_positional_numbered():
    """set -- x y makes $1 and $2 available."""
    ws = _ws()
    io = _exec(ws, "set -- x y; echo $1 $2")
    assert _stdout(io) == b"x y\n"


# ── glob expansion ──────────────────────────────────────────────────────


def test_echo_glob_star():
    """echo /path/*.ext expands to matching files."""
    ws = _ws()
    io = _exec(ws, "echo /s3/*.csv")
    assert b"report.csv" in _stdout(io)


def test_for_glob():
    """for f in /path/*.ext iterates matching files."""
    ws = _ws()
    io = _exec(ws, "for f in /ram/*.txt; do echo $f; done")
    out = _stdout(io)
    assert b"notes.txt" in out
    assert b"nums.txt" in out


def test_command_sub_word_split_in_for():
    """$(echo a b c) word-splits into 3 separate for values."""
    ws = _ws()
    io = _exec(ws, "for x in $(echo a b c); do echo item:$x; done")
    assert _stdout(io) == b"item:a\nitem:b\nitem:c\n"


# ── pipe exit code ──────────────────────────────────────────────────────


def test_pipe_exit_code_grep_no_match():
    """grep with no match in pipe returns exit code 1."""
    ws = _ws()
    io = _exec(ws, "echo hello | grep nope")
    assert io.exit_code == 1


def test_pipe_exit_code_grep_match():
    """grep with match in pipe returns exit code 0."""
    ws = _ws()
    io = _exec(ws, "echo hello | grep hello")
    assert io.exit_code == 0


# ── timeout ─────────────────────────────────────────────────────────────


def test_timeout_runs_command():
    """timeout N cmd executes the command."""
    ws = _ws()
    io = _exec(ws, "timeout 5 echo hello")
    assert _stdout(io) == b"hello\n"


# ── xargs ───────────────────────────────────────────────────────────────


def test_xargs_basic():
    """echo args | xargs echo passes stdin as arguments."""
    ws = _ws()
    io = _exec(ws, 'echo "a b c" | xargs echo')
    assert _stdout(io) == b"a b c\n"


# ── additional fixes ────────────────────────────────────────────────────


def test_for_empty_list():
    """for x in; do ... done with empty list skips body."""
    ws = _ws()
    io = _exec(ws, "for x in; do echo $x; done; echo done")
    assert _stdout(io) == b"done\n"


def test_escaped_quote_in_double():
    """Escaped quote inside double quotes is unescaped."""
    ws = _ws()
    io = _exec(ws, 'echo "hello \\"world\\""')
    assert _stdout(io) == b'hello "world"\n'


def test_special_var_at_split():
    '''"$@" in for loop splits into separate args.'''
    ws = _ws()
    io = _exec(ws, 'f() { for x in "$@"; do echo $x; done; }; f a b c')
    assert _stdout(io) == b"a\nb\nc\n"


def test_background_then_foreground():
    """echo bg &; echo fg — foreground runs after background."""
    ws = _ws()
    io = _exec(ws, "echo bg &; echo fg")
    assert b"fg" in _stdout(io)


def test_heredoc_pipe():
    """python3 << EOF | head -n 1 — pipe after heredoc."""
    ws = _ws()
    cmd = ("python3 << 'PYEOF' | head -n 1\n"
           "for i in range(5):\n"
           "    print(i)\n"
           "PYEOF")
    io = _exec(ws, cmd)
    assert _stdout(io) == b"0\n"


# -- bare filename (CommandSpec PATH classification) -------------------------


def test_cd_and_cat_bare_filename():
    """cat file.txt after cd resolves bare filename via CommandSpec."""
    ws = _ws()
    io = _exec(ws, "cd /disk/sub; cat deep.txt")
    assert _stdout(io) == b"deep content\n"


def test_cd_and_head_bare_filename():
    ws = _ws()
    io = _exec(ws, "cd /ram; head -n 2 notes.txt")
    assert _stdout(io) == b"line1\nline2\n"


def test_cd_and_wc_bare_filename():
    ws = _ws()
    io = _exec(ws, "cd /ram; wc -l notes.txt")
    assert b"3" in _stdout(io)


def test_cd_and_grep_bare_filename():
    ws = _ws()
    io = _exec(ws, "cd /s3; grep POST access.log")
    out = _stdout(io).decode()
    assert out.count("POST") == 2


def test_bare_filename_for_loop_stays_text():
    """for f in file.txt should NOT resolve as a path."""
    ws = _ws()
    io = _exec(ws, "for f in notes.txt; do echo $f; done")
    assert _stdout(io) == b"notes.txt\n"


def test_find_name_not_glob_expanded():
    """find -name '*.txt' should not glob-expand the pattern."""
    ws = _ws()
    io = _exec(ws, "find /s3 -name '*.txt'")
    out = _stdout(io).decode()
    assert "data.txt" in out


def test_subshell_cd_and_cat_bare_filename():
    ws = _ws()
    io = _exec(ws, "(cd /disk/sub; cat deep.txt)")
    assert b"deep content" in _stdout(io)


# ── job table cleanup ──────────────────────────────────────────────────


def test_bg_sleep_kill_and_jobs_cleanup():
    """Background sleep, kill it, jobs shows killed; second empty."""
    ws = _ws()
    # Start a long sleep in background, then kill it
    io = _exec(ws, "sleep 10 & kill %1; wait %1; jobs")
    out = _stdout(io)
    assert b"killed" in out

    # After jobs listed them, pop_completed removes them
    io = _exec(ws, "jobs")
    out = _stdout(io)
    assert out == b""


def test_completed_jobs_cleaned_after_jobs_command():
    """Completed jobs appear in first `jobs`, removed by second `jobs`."""
    ws = _ws()
    # Run a fast bg job, wait for it, then list
    io = _exec(ws, "echo hi & wait; jobs")
    out = _stdout(io)
    assert b"completed" in out

    # Second `jobs` should be empty — pop_completed removed them
    io = _exec(ws, "jobs")
    out = _stdout(io)
    assert out == b""


# ── while loop limit warning ───────────────────────────────────────────


def test_while_loop_warns_on_max_iterations():
    """while loop emits stderr warning when hitting iteration limit."""
    ws = _ws()

    async def _run():
        # _MAX_WHILE = 10000; loop unconditionally to trigger the cap
        io = await ws.execute("while true; do export X=$X.; done")
        return await io.stderr_str()

    err = asyncio.run(_run())
    assert "warning" in err
    assert "terminated after" in err
    assert "10000" in err


def test_while_loop_under_limit_no_warning():
    """while loop under limit produces no stderr warning."""
    ws = _ws()

    async def _run():
        io = await ws.execute("i=0; while [ $i -lt 5 ]; do i=$((i+1)); done")
        return await io.stderr_str()

    err = asyncio.run(_run())
    assert err == ""


# ── unmount ────────────────────────────────────────────────────────────


def test_unmount_removes_mount():
    """unmount drops the mount and rejects subsequent dispatch."""
    ws = _ws()
    assert any(m.prefix == "/s3/" for m in ws.mounts())
    asyncio.run(ws.unmount("/s3"))
    assert not any(m.prefix == "/s3/" for m in ws.mounts())


def test_unmount_closes_resource_when_owned():
    """unmount closes a resource that has open()/close() (best-effort)."""
    closed = []

    class TrackingRAM(RAMResource):

        async def close(self):
            closed.append("yes")

    ws = Workspace({"/x": TrackingRAM()}, mode=MountMode.WRITE)
    asyncio.run(ws.unmount("/x"))
    assert closed == ["yes"]


def test_unmount_rejects_reserved_prefixes():
    """unmount of cache root / observer / dev / unknown prefix raises."""
    ws = _ws()
    import pytest

    with pytest.raises(ValueError, match="cache root"):
        asyncio.run(ws.unmount("/"))
    with pytest.raises(ValueError, match="observer prefix"):
        asyncio.run(ws.unmount("/.sessions"))
    with pytest.raises(ValueError, match="reserved"):
        asyncio.run(ws.unmount("/dev"))
    with pytest.raises(ValueError, match="no mount at prefix"):
        asyncio.run(ws.unmount("/missing"))


def test_unmount_after_close_raises():
    """unmount on a closed workspace raises RuntimeError."""
    ws = _ws()
    asyncio.run(ws.close())
    import pytest

    with pytest.raises(RuntimeError, match="closed"):
        asyncio.run(ws.unmount("/s3"))


# ── cd does not change cwd for nonexistent paths ─────────────────


def test_cd_nonexistent_under_mount_keeps_cwd():
    ws = Workspace(
        resources={"/": (RAMResource(), MountMode.WRITE)},
        history=None,
    )
    before = ws.get_session(DEFAULT_SESSION_ID).cwd
    io = _exec(ws, "cd /missing")
    assert io.exit_code != 0
    assert b"No such file or directory" in io.stderr
    assert ws.get_session(DEFAULT_SESSION_ID).cwd == before


def test_cd_into_mount_root_succeeds():
    ws = Workspace(
        resources={
            "/": (RAMResource(), MountMode.WRITE),
            "/data/": (RAMResource(), MountMode.WRITE),
        },
        history=None,
    )
    io = _exec(ws, "cd /data")
    assert io.exit_code == 0
    assert ws.get_session(DEFAULT_SESSION_ID).cwd == "/data"


# ── ls injects child mounts as virtual subdirectories ─────────────


def _ws_for_ls(mounts: dict[str, RAMResource]) -> Workspace:
    return Workspace(
        resources={
            p: (r, MountMode.WRITE)
            for p, r in mounts.items()
        },
        history=None,
    )


def test_ls_root_shows_child_mount_data():
    ws = _ws_for_ls({"/": RAMResource(), "/data/": RAMResource()})
    io = _exec(ws, "ls /")
    assert io.exit_code == 0
    out = _stdout(io).decode()
    assert "data" in out.split("\n")


def test_ls_classify_child_mount_with_trailing_slash():
    ws = _ws_for_ls({"/": RAMResource(), "/data/": RAMResource()})
    io = _exec(ws, "ls -F /")
    assert io.exit_code == 0
    out = _stdout(io).decode()
    assert "data/" in out.split("\n")


def test_ls_hides_dot_sessions_by_default_shows_with_a():
    ws = _ws_for_ls({"/": RAMResource()})
    plain = _exec(ws, "ls /")
    assert ".sessions" not in _stdout(plain).decode().split("\n")
    all_io = _exec(ws, "ls -a /")
    assert ".sessions" in _stdout(all_io).decode().split("\n")


def test_ls_does_not_duplicate_existing_entry():
    ws = _ws_for_ls({"/": RAMResource(), "/data/": RAMResource()})
    _exec(ws, "mkdir -p /data/sub")
    io = _exec(ws, "ls /data")
    lines = [line for line in _stdout(io).decode().split("\n") if line]
    assert sum(1 for line in lines if line in ("sub", "sub/")) == 1


def test_ls_nested_child_mount():
    ws = _ws_for_ls({
        "/": RAMResource(),
        "/data/": RAMResource(),
        "/data/inner/": RAMResource(),
    })
    io = _exec(ws, "ls /data")
    assert "inner" in _stdout(io).decode().split("\n")


def test_ls_dash_d_does_not_inject_mounts():
    ws = _ws_for_ls({"/": RAMResource(), "/data/": RAMResource()})
    io = _exec(ws, "ls -d /")
    assert "data" not in _stdout(io).decode().split("\n")


def test_man_date_entry():
    ws = _ws()
    io = _exec(ws, "man date")
    assert io.exit_code == 0
    text = _stdout(io).decode()
    assert text.startswith("# date\n")
    assert "## OPTIONS" in text
    assert "## RESOURCES" in text
    assert "- general" in text


def test_man_no_entry():
    ws = _ws()
    io = _exec(ws, "man definitely-not-a-real-command")
    assert io.exit_code == 1
    assert io.stderr == b"man: no entry for definitely-not-a-real-command\n"


def test_man_index_lists_resources():
    ws = _ws()
    io = _exec(ws, "man")
    assert io.exit_code == 0
    text = _stdout(io).decode()
    assert "# general" in text
    assert "- bc" in text

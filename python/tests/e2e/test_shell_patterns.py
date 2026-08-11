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

from .conftest import make_resource_ws, run, run_exit

FILES = {
    "logs/app.log": (b"2026-01-01 INFO startup\n"
                     b"2026-01-02 ERROR connection refused\n"
                     b"2026-01-03 INFO request handled\n"
                     b"2026-01-04 WARN slow query\n"
                     b"2026-01-05 ERROR timeout\n"
                     b"2026-01-06 INFO shutdown\n"),
    "logs/access.log": (b"GET /api/users 200\n"
                        b"POST /api/users 201\n"
                        b"GET /api/users 200\n"
                        b"DELETE /api/users/1 404\n"
                        b"GET /api/health 200\n"),
    "data/scores.csv":
    b"alice,90\nbob,75\ncharlie,90\nalice,85\nbob,95\n",
    "data/words.txt":
    b"hello\nworld\nhello\nfoo\nbar\nfoo\nhello\n",
    "data/numbers.txt":
    b"3\n1\n4\n1\n5\n9\n2\n6\n5\n3\n",
    "src/main.py":
    b"import os\nimport sys\nprint('hello')\n",
    "src/utils.py":
    b"def add(a, b):\n    return a + b\n",
    "config.json":
    b'{"name": "mirage", "version": "1.0"}\n',
    "empty.txt":
    b"",
}


@pytest.fixture(params=["ram", "s3", "disk"])
def ws(request, tmp_path):
    yield from make_resource_ws(request, tmp_path, FILES)


# ---------------------------------------------------------------------------
# Nested loops
# ---------------------------------------------------------------------------


def test_nested_for_with_file_ops(ws):
    cmd = ("for d in logs data; do "
           "for f in $(find /data/$d -type f | sort); do "
           "echo \"$d: $f\"; done; done")
    result = run(ws, cmd)
    assert "logs: /data/logs/app.log" in result
    assert "data: /data/data/scores.csv" in result


def test_for_with_if_and_grep(ws):
    cmd = ("for f in $(find /data/logs -type f | sort); do "
           "if grep -q ERROR $f; then echo \"ERRORS: $f\"; fi; done")
    result = run(ws, cmd)
    assert "ERRORS: /data/logs/app.log" in result
    assert "ERRORS: /data/logs/access.log" not in result


def test_while_read_with_nested_if(ws):
    cmd = ("find /data/data -type f | sort | "
           "while read f; do "
           "if [ \"$(wc -l < $f)\" -gt 3 ]; then "
           "echo \"big: $f\"; "
           "else echo \"small: $f\"; fi; done")
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert len(lines) == 3


# ---------------------------------------------------------------------------
# Multi-stage pipelines
# ---------------------------------------------------------------------------


def test_sort_uniq_count_pipeline(ws):
    cmd = "cat /data/data/words.txt | sort | uniq -c | sort -rn | head -n 1"
    result = run(ws, cmd).split()
    assert result[0] == "3"
    assert result[1] == "hello"


def test_grep_pipe_cut_pipe_sort_pipe_uniq(ws):
    cmd = ("cat /data/logs/access.log | cut -d ' ' -f 1 | sort | uniq -c "
           "| sort -rn")
    result = run(ws, cmd).strip()
    lines = result.splitlines()
    assert len(lines) == 3
    first = lines[0].split()
    assert first[0] == "3"
    assert first[1] == "GET"


def test_five_stage_pipeline(ws):
    cmd = ("cat /data/data/numbers.txt | sort -n | uniq | head -n 3 "
           "| tr '\\n' ','")
    result = run(ws, cmd)
    assert result.startswith("1,2,3")


def test_grep_count_errors_across_files(ws):
    cmd = "grep -c ERROR /data/logs/app.log"
    result = run(ws, cmd).strip()
    assert result == "2"


# ---------------------------------------------------------------------------
# Command substitution in pipelines
# ---------------------------------------------------------------------------


def test_command_sub_in_echo(ws):
    cmd = "echo \"lines: $(wc -l < /data/data/words.txt)\""
    result = run(ws, cmd).strip()
    assert result == "lines: 7"


def test_nested_command_sub(ws):
    cmd = "echo $(echo $(echo deep))"
    result = run(ws, cmd).strip()
    assert result == "deep"


def test_command_sub_in_for_values(ws):
    cmd = ("for line in $(grep ERROR /data/logs/app.log | cut -d ' ' -f 1); "
           "do echo \"date:$line\"; done")
    result = run(ws, cmd)
    assert "date:2026-01-02" in result
    assert "date:2026-01-05" in result


def test_command_sub_in_test(ws):
    cmd = ("if [ $(grep -c ERROR /data/logs/app.log) -gt 1 ]; then "
           "echo many_errors; else echo few_errors; fi")
    result = run(ws, cmd).strip()
    assert result == "many_errors"


# ---------------------------------------------------------------------------
# While read with processing
# ---------------------------------------------------------------------------


def test_while_read_with_variable_transform(ws):
    cmd = ("echo -e 'alice\\nbob\\ncharlie' | "
           "while read name; do echo \"user:$name\"; done")
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert lines == ["user:alice", "user:bob", "user:charlie"]


def test_while_read_counter(ws):
    cmd = ("export count=0; "
           "cat /data/data/words.txt | sort -u | "
           "while read w; do "
           "export count=$((count+1)); echo \"$count:$w\"; done")
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert lines[0] == "1:bar"


def test_while_read_pipe_to_wc(ws):
    cmd = ("grep ERROR /data/logs/app.log | "
           "while read line; do echo \"ALERT: $line\"; done | wc -l")
    result = run(ws, cmd).strip()
    assert result == "2"


def test_while_read_with_grep_filter(ws):
    cmd = ("cat /data/logs/access.log | "
           "while read line; do echo $line; done | grep 200 | wc -l")
    result = run(ws, cmd).strip()
    assert result == "3"


# ---------------------------------------------------------------------------
# Subshell and grouping
# ---------------------------------------------------------------------------


def test_subshell_pipe_chain(ws):
    cmd = "(echo hello; echo world) | sort | tr a-z A-Z"
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert lines == ["HELLO", "WORLD"]


def test_brace_group_redirect(ws):
    cmd = "{ echo first; echo second; } > /data/out.txt; cat /data/out.txt"
    result = run(ws, cmd)
    assert result == "first\nsecond\n"


def test_subshell_variable_isolation(ws):
    cmd = "export X=outer; (export X=inner; echo $X); echo $X"
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert lines == ["inner", "outer"]


def test_subshell_function_def_no_leak(ws):
    cmd = "(only_inner() { echo inner; }); only_inner 2>/dev/null || echo gone"
    assert run(ws, cmd).strip() == "gone"


def test_subshell_function_redef_isolation(ws):
    cmd = "greet() { echo outer; }; (greet() { echo inner; }; greet); greet"
    lines = run(ws, cmd).strip().splitlines()
    assert lines == ["inner", "outer"]


def test_subshell_function_inherited(ws):
    cmd = "greet() { echo hi; }; (greet)"
    assert run(ws, cmd).strip() == "hi"


def test_subshell_positional_isolation(ws):
    cmd = "set -- a b c; (set -- x); echo $# $1"
    assert run(ws, cmd).strip() == "3 a"


def test_subshell_positional_inherited(ws):
    cmd = "set -- a b; (echo $1 $2)"
    assert run(ws, cmd).strip() == "a b"


# ---------------------------------------------------------------------------
# Functions with pipelines
# ---------------------------------------------------------------------------


def test_function_in_pipeline(ws):
    cmd = "upper() { tr a-z A-Z; }; echo hello | upper"
    result = run(ws, cmd).strip()
    assert result == "HELLO"


def test_function_with_args_in_loop(ws):
    cmd = ("classify() { case $1 in "
           "*.py) echo \"python: $1\";; "
           "*.txt) echo \"text: $1\";; "
           "*.json) echo \"json: $1\";; "
           "*.csv) echo \"csv: $1\";; "
           "*.log) echo \"log: $1\";; "
           "*) echo \"other: $1\";; esac; }; "
           "find /data -type f | sort | "
           "while read f; do classify $f; done")
    result = run(ws, cmd)
    assert "python: /data/src/main.py" in result
    assert "json: /data/config.json" in result
    assert "log: /data/logs/app.log" in result
    assert "csv: /data/data/scores.csv" in result


# ---------------------------------------------------------------------------
# Conditional chains (&&, ||)
# ---------------------------------------------------------------------------


def test_and_chain_with_grep(ws):
    cmd = ("grep -q ERROR /data/logs/app.log && "
           "echo 'has errors' || echo 'clean'")
    result = run(ws, cmd).strip()
    assert result == "has errors"


def test_or_chain_fallback(ws):
    cmd = ("grep -q FATAL /data/logs/app.log && "
           "echo 'has fatal' || echo 'no fatal'")
    result = run(ws, cmd).strip()
    assert result == "no fatal"


def test_chained_conditionals(ws):
    cmd = ("grep -q ERROR /data/logs/app.log && "
           "grep -q INFO /data/logs/app.log && "
           "echo 'has both'")
    result = run(ws, cmd).strip()
    assert result == "has both"


# ---------------------------------------------------------------------------
# Redirects combined with pipes
# ---------------------------------------------------------------------------


def test_pipe_with_output_redirect(ws):
    cmd = ("grep ERROR /data/logs/app.log | sort > /data/errors.txt; "
           "cat /data/errors.txt")
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert len(lines) == 2
    assert lines == sorted(lines)


def test_append_redirect_in_loop(ws):
    cmd = ("for x in one two three; do "
           "echo $x >> /data/result.txt; done; cat /data/result.txt")
    result = run(ws, cmd)
    assert result == "one\ntwo\nthree\n"


def test_stdin_redirect_in_pipeline(ws):
    cmd = "sort < /data/data/numbers.txt | uniq | wc -l"
    result = run(ws, cmd).strip()
    assert result == "7"


# ---------------------------------------------------------------------------
# Process substitution
# ---------------------------------------------------------------------------


def test_input_process_substitution(ws):
    cmd = "cat <(echo hello)"
    result = run(ws, cmd)
    assert "hello" in result


# ---------------------------------------------------------------------------
# Sed and tr pipelines
# ---------------------------------------------------------------------------


def test_sed_in_pipeline(ws):
    cmd = "cat /data/logs/app.log | grep ERROR | sed 's/ERROR/CRITICAL/'"
    result = run(ws, cmd)
    assert "CRITICAL" in result
    assert "ERROR" not in result


def test_tr_multiple_transforms(ws):
    cmd = "echo 'Hello World' | tr A-Z a-z | tr ' ' '_'"
    result = run(ws, cmd).strip()
    assert result == "hello_world"


# ---------------------------------------------------------------------------
# Complex real-world patterns
# ---------------------------------------------------------------------------


def test_log_analysis_pipeline(ws):
    cmd = ("cat /data/logs/app.log | grep -v INFO | "
           "cut -d ' ' -f 2 | sort | uniq -c | sort -rn")
    result = run(ws, cmd).strip()
    lines = result.splitlines()
    first = lines[0].split()
    assert first[0] == "2"
    assert first[1] == "ERROR"


def test_find_grep_count_pattern(ws):
    cmd = ("find /data/src -name '*.py' -type f | sort | "
           "while read f; do "
           "echo \"$(grep -c import $f) $f\"; done")
    result = run(ws, cmd)
    assert "2 /data/src/main.py" in result


def test_csv_processing_pipeline(ws):
    cmd = ("cat /data/data/scores.csv | sort -t, -k2 -rn | head -n 1 "
           "| cut -d, -f1")
    result = run(ws, cmd).strip()
    assert result == "bob"


def test_word_frequency_full_pipeline(ws):
    cmd = ("cat /data/data/words.txt | sort | uniq -c | sort -rn | "
           "while read count word; do "
           "echo \"$word appears $count times\"; done | head -n 2")
    result = run(ws, cmd)
    lines = result.strip().splitlines()
    assert "hello appears 3 times" in lines[0]
    assert "foo appears 2 times" in lines[1]


def test_while_read_with_command_sub_body(ws):
    cmd = ("find /data -name '*.py' -type f | sort | "
           "while read f; do "
           "echo \"$f: $(wc -l < $f) lines\"; done")
    result = run(ws, cmd)
    assert "/data/src/main.py: 3 lines" in result
    assert "/data/src/utils.py: 2 lines" in result


def test_multiline_script_with_function_and_loop(ws):
    cmd = ("count_matches() { grep -c $1 $2; }; "
           "find /data/logs -type f | sort | "
           "while read f; do "
           "echo \"$f: $(count_matches ERROR $f) errors\"; done")
    result = run(ws, cmd)
    assert "/data/logs/app.log: 2 errors" in result
    assert "/data/logs/access.log: 0 errors" in result


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_file_in_pipeline(ws):
    cmd = "cat /data/empty.txt | wc -l"
    result = run(ws, cmd).strip()
    assert result == "0"


def test_while_read_empty_input(ws):
    cmd = ("cat /data/empty.txt | "
           "while read line; do echo \"got: $line\"; done; echo done")
    result = run(ws, cmd).strip()
    assert result == "done"


def test_deeply_nested_command_sub(ws):
    cmd = "echo $(echo $(echo $(echo nested)))"
    result = run(ws, cmd).strip()
    assert result == "nested"


def test_pipe_exit_code_last_command(ws):
    code = run_exit(ws, "echo hello | grep world")
    assert code != 0


def test_pipe_exit_code_success(ws):
    code = run_exit(ws, "echo hello | grep hello")
    assert code == 0

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

from mirage.agents.ops import (io_to_exec_result, io_to_file_infos,
                               io_to_grep_matches, parse_grep, parse_ls)
from mirage.io.types import IOResult


def _io(stdout: bytes = b"", stderr: bytes = b"", exit_code: int = 0):
    return IOResult(stdout=stdout, stderr=stderr, exit_code=exit_code)


def test_parse_grep_reads_path_line_text():
    matches = parse_grep("a.py:12:hello\nb/c.py:3:world\n")
    assert [(m.path, m.line, m.text) for m in matches] == [
        ("a.py", 12, "hello"),
        ("b/c.py", 3, "world"),
    ]


def test_parse_grep_skips_non_numeric_and_short_lines():
    matches = parse_grep("Binary file x matches\na.py:notanum:t\na.py:1:ok")
    assert [(m.path, m.line, m.text) for m in matches] == [("a.py", 1, "ok")]


def test_parse_grep_empty():
    assert parse_grep("") == []
    assert parse_grep("   \n ") == []


def test_parse_ls_marks_dirs_and_derives_name():
    infos = parse_ls("src/\nREADME.md\n")
    assert [(i.path, i.name, i.is_dir) for i in infos] == [
        ("src", "src", True),
        ("README.md", "README.md", False),
    ]


def test_parse_ls_joins_base_when_given():
    infos = parse_ls("a\nsub/\n", base="/repo/")
    assert [(i.path, i.name, i.is_dir) for i in infos] == [
        ("/repo/a", "a", False),
        ("/repo/sub", "sub", True),
    ]


def test_parse_ls_empty():
    assert parse_ls("") == []


def test_exec_result_appends_stderr_to_stdout():
    r = io_to_exec_result(_io(b"out", b"bad", 1))
    assert r.output == "out\nbad"
    assert r.exit_code == 1


def test_exec_result_stderr_only():
    assert io_to_exec_result(_io(b"", b"bad", 2)).output == "bad"


def test_exec_result_stdout_only():
    r = io_to_exec_result(_io(b"fine", b"", 0))
    assert r.output == "fine"
    assert r.exit_code == 0


def test_io_helpers_delegate_to_parsers():
    assert io_to_grep_matches(_io(b"a.py:1:x"))[0].path == "a.py"
    assert io_to_file_infos(_io(b"d/"), base="/b")[0].path == "/b/d"

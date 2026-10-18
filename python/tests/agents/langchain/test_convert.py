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

from mirage.agents.langchain.convert import (
    io_to_execute_response,
    io_to_file_infos,
    io_to_grep_matches,
)
from mirage.io.types import IOResult


def test_io_to_execute_response_basic():
    io = IOResult(stdout=b"hello world\n", exit_code=0)
    resp = io_to_execute_response(io)
    assert resp.output == "hello world\n"
    assert resp.exit_code == 0
    assert resp.truncated is False


def test_io_to_execute_response_none_stdout():
    io = IOResult(stdout=None, exit_code=1)
    resp = io_to_execute_response(io)
    assert resp.output == ""
    assert resp.exit_code == 1


def test_io_to_execute_response_stderr_appended():
    io = IOResult(stdout=b"out", stderr=b"err", exit_code=1)
    resp = io_to_execute_response(io)
    assert "out" in resp.output
    assert "err" in resp.output


def test_io_to_grep_matches():
    io = IOResult(
        stdout=b"/a.txt:1:hello world\n/b.txt:5:hello there\n", exit_code=0
    )
    matches = io_to_grep_matches(io)
    assert len(matches) == 2
    assert matches[0]["path"] == "/a.txt"
    assert matches[0]["line"] == 1
    assert matches[0]["text"] == "hello world"


def test_io_to_grep_matches_skips_a_row_without_a_line_number():
    io = IOResult(stdout=b"/a:b.txt:hello\n/c.txt:2:kept\n", exit_code=0)
    matches = io_to_grep_matches(io)
    assert matches == [{"path": "/c.txt", "line": 2, "text": "kept"}]


def test_io_to_grep_matches_empty():
    io = IOResult(stdout=b"", exit_code=1)
    matches = io_to_grep_matches(io)
    assert matches == []


def test_io_to_file_infos():
    io = IOResult(
        stdout=b"/foo/bar.txt\n/foo/baz.py\n/foo/sub/\n", exit_code=0
    )
    infos = io_to_file_infos(io)
    assert len(infos) == 3
    dirs = [i for i in infos if i.get("is_dir")]
    assert len(dirs) == 1
    assert dirs[0]["path"] == "/foo/sub"


def test_io_to_file_infos_empty():
    io = IOResult(stdout=b"", exit_code=0)
    infos = io_to_file_infos(io)
    assert infos == []

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

from .conftest import make_resource_ws, run

FILES = {
    "docs/readme.txt": b"hello world\n",
    "docs/notes.txt": b"some notes\n",
    "src/main.py": b"print('hello')\n",
    "src/utils/helpers.py": b"def helper(): pass\n",
    "data.json": b'{"key": "value"}\n',
}


@pytest.fixture(params=["ram", "s3", "disk"])
def resource_ws(request, tmp_path):
    yield from make_resource_ws(request, tmp_path, FILES)


def test_find_type_f(resource_ws):
    result = run(resource_ws, "find /data -type f | sort")
    lines = result.strip().splitlines()
    assert "/data/data.json" in lines
    assert "/data/docs/readme.txt" in lines
    assert "/data/src/main.py" in lines
    assert len(lines) == 5


def test_find_maxdepth_0(resource_ws):
    result = run(resource_ws, "find /data -maxdepth 0 -type f | sort")
    lines = [line for line in result.strip().splitlines() if line]
    assert lines == []


def test_find_maxdepth_1(resource_ws):
    result = run(resource_ws, "find /data -maxdepth 1 -type f | sort")
    lines = result.strip().splitlines()
    assert "/data/data.json" in lines
    assert "/data/docs/notes.txt" not in lines
    assert "/data/src/main.py" not in lines


def test_find_maxdepth_2(resource_ws):
    result = run(resource_ws, "find /data -maxdepth 2 -type f | sort")
    lines = result.strip().splitlines()
    assert "/data/data.json" in lines
    assert "/data/docs/notes.txt" in lines
    assert "/data/docs/readme.txt" in lines
    assert "/data/src/main.py" in lines
    assert "/data/src/utils/helpers.py" not in lines


def test_find_name_pattern(resource_ws):
    result = run(resource_ws, "find /data -name '*.txt' | sort")
    lines = result.strip().splitlines()
    assert lines == ["/data/docs/notes.txt", "/data/docs/readme.txt"]


def test_find_pipe_sort_pipe_while_read_echo(resource_ws):
    cmd = ("find /data -maxdepth 2 -type f | sort | "
           "while read f; do echo \"=== $f ===\"; done")
    result = run(resource_ws, cmd)
    lines = result.strip().splitlines()
    for line in lines:
        assert line.startswith("=== ") and line.endswith(" ===")
    paths = [line.removeprefix("=== ").removesuffix(" ===") for line in lines]
    assert paths == sorted(paths)
    assert "/data/data.json" in paths


def test_find_pipe_sort_pipe_while_read_file(resource_ws):
    cmd = ("find /data -maxdepth 2 -type f -name '*.json' | sort | "
           "while read f; do echo \"=== $f ===\"; file $f; done")
    result = run(resource_ws, cmd)
    lines = result.strip().splitlines()
    assert "=== /data/data.json ===" in lines
    assert any("json" in line for line in lines)


def test_find_pipe_while_read_echo_content(resource_ws):
    cmd = ("find /data -name '*.txt' -type f | sort | "
           "while read f; do echo \"FILE: $f\"; done")
    result = run(resource_ws, cmd)
    lines = result.strip().splitlines()
    file_paths = [line.removeprefix("FILE: ") for line in lines]
    assert "/data/docs/notes.txt" in file_paths
    assert "/data/docs/readme.txt" in file_paths


def test_find_type_d_memory(resource_ws):
    result = run(resource_ws, "find /data -type d | sort")
    lines = result.strip().splitlines()
    if lines:
        assert all("/data" in line for line in lines)

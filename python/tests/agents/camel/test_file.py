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

import pytest

from mirage import MountMode, Workspace
from mirage.agents.camel import MirageFileToolkit
from mirage.resource.ram import RAMResource


@pytest.fixture
def workspace():
    ram = RAMResource()
    yield Workspace({"/": ram}, mode=MountMode.WRITE)


@pytest.fixture
def toolkit(workspace):
    tk = MirageFileToolkit(workspace)
    yield tk
    tk.close()


def _strip_markdown_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        return "\n".join(
            lines[1:-1] if lines[-1].startswith("```") else lines[1:])
    return text


def test_write_text_file_then_read(toolkit):
    msg = toolkit.write_to_file(title="Hello",
                                content="hi there",
                                filename="/notes/hello.md")
    assert "hello.md" in msg
    out = toolkit.read_file(file_paths="/notes/hello.md")
    assert "hi there" in out


def test_write_json_file_then_read(toolkit):
    msg = toolkit.write_to_file(title="data",
                                content={
                                    "a": 1,
                                    "b": [2, 3]
                                },
                                filename="/data.json")
    assert "data.json" in msg
    out = toolkit.read_file(file_paths="/data.json")
    parsed = json.loads(_strip_markdown_code_fence(out))
    assert parsed == {"a": 1, "b": [2, 3]}


def test_edit_file_replaces_content(toolkit):
    toolkit.write_to_file(title="t", content="old\nkeep\n", filename="/e.txt")
    msg = toolkit.edit_file(file_path="/e.txt",
                            old_content="old",
                            new_content="new")
    assert "successfully" in msg.lower() or "edited" in msg.lower()
    out = toolkit.read_file(file_paths="/e.txt")
    assert "new" in out and "keep" in out and "old" not in out.split("keep")[0]


def test_search_files_by_name(toolkit):
    toolkit.write_to_file(title="a", content="x", filename="/dir/a.txt")
    toolkit.write_to_file(title="b", content="y", filename="/dir/b.md")
    out = toolkit.search_files(file_name="a.txt", path="/dir")
    assert "a.txt" in out


def test_glob_files(toolkit):
    toolkit.write_to_file(title="a", content="x", filename="/g/x.py")
    toolkit.write_to_file(title="a", content="y", filename="/g/y.py")
    out = toolkit.glob_files(pattern="*.py", path="/g")
    assert "x.py" in out and "y.py" in out


def test_grep_files(toolkit):
    toolkit.write_to_file(title="a",
                          content="needle here\n",
                          filename="/q/a.txt")
    toolkit.write_to_file(title="b", content="haystack\n", filename="/q/b.txt")
    out = toolkit.grep_files(pattern="needle", path="/q")
    assert "needle" in out
    assert "a.txt" in out


def test_search_files_names_the_reason_beside_a_refusal():
    # stderr is bash's bare `Permission denied`; the reason rides the
    # refusal record, and a text surface appends it as one more line.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   route_policy=lambda ctx: {"deny": "no walks"}
                   if ctx.command == "find" else None)
    tk = MirageFileToolkit(ws)
    try:
        out = tk.search_files(file_name="a.txt", path="/")
    finally:
        tk.close()
    assert out == "find: Permission denied\npolicy denied: no walks\n"

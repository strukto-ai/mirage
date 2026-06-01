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

from mirage.commands.builtin.github.cat import cat
from mirage.commands.builtin.github.diff import diff
from mirage.commands.builtin.github.du import du
from mirage.commands.builtin.github.find import find
from mirage.commands.builtin.github.head import head
from mirage.commands.builtin.github.ls import ls
from mirage.commands.builtin.github.rg import rg
from mirage.commands.builtin.github.sed import sed
from mirage.commands.builtin.github.sort import sort_cmd
from mirage.commands.builtin.github.stat import stat
from mirage.commands.builtin.github.tail import tail
from mirage.commands.builtin.github.tree import tree
from mirage.commands.builtin.github.wc import wc
from mirage.io.stream import materialize
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS


@pytest.fixture(autouse=True)
def _patch_read(monkeypatch):

    async def _read_bytes(config, owner, repo, sha):
        return MOCK_BLOBS[sha]

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)


@pytest.mark.asyncio
async def test_cat_returns_content(github_env):
    accessor, index = github_env
    stdout, io = await cat(
        accessor,
        [PathSpec(original="/README.md", directory="/", resolved=True)],
        index=index,
    )
    data = await materialize(stdout)
    assert data == MOCK_BLOBS["aaa111"]


@pytest.mark.asyncio
async def test_cat_numbered_lines(github_env):
    accessor, index = github_env
    stdout, io = await cat(
        accessor,
        [PathSpec(original="/src/utils.py", directory="/src", resolved=True)],
        n=True,
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    lines = text.strip().splitlines()
    assert lines[0].strip().startswith("1\t")


@pytest.mark.asyncio
async def test_head_n3(github_env):
    accessor, index = github_env
    stdout, io = await head(
        accessor,
        [PathSpec(original="/src/main.py", directory="/src", resolved=True)],
        n="3",
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    lines = text.splitlines()
    assert len(lines) == 3


@pytest.mark.asyncio
async def test_tail_n2(github_env):
    accessor, index = github_env
    stdout, io = await tail(
        accessor,
        [PathSpec(original="/src/utils.py", directory="/src", resolved=True)],
        n="2",
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    lines = text.splitlines()
    assert len(lines) == 2
    assert "return 42" in lines[-1]


@pytest.mark.asyncio
async def test_wc_full(github_env):
    accessor, index = github_env
    stdout, io = await wc(
        accessor,
        [PathSpec(original="/src/utils.py", directory="/src", resolved=True)],
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    parts = text.rstrip("\n").split("\t")
    assert len(parts) == 4
    line_count, word_count, byte_count = int(parts[0]), int(parts[1]), int(
        parts[2])
    assert line_count > 0
    assert word_count > 0
    assert byte_count == len(MOCK_BLOBS["bbb333"])
    assert parts[3] == "/src/utils.py"


@pytest.mark.asyncio
async def test_wc_line_only(github_env):
    accessor, index = github_env
    stdout, io = await wc(
        accessor,
        [PathSpec(original="/src/utils.py", directory="/src", resolved=True)],
        args_l=True,
        index=index,
    )
    data = await materialize(stdout)
    count = int(data.decode().split("\t")[0])
    expected = MOCK_BLOBS["bbb333"].decode().count("\n")
    assert count == expected


@pytest.mark.asyncio
async def test_ls_directory(github_env):
    accessor, index = github_env
    stdout, io = await ls(
        accessor,
        [PathSpec(original="/src", directory="/src", resolved=False)],
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    names = text.strip().splitlines()
    assert "__init__.py" in names
    assert "main.py" in names
    assert "utils.py" in names


@pytest.mark.asyncio
async def test_find_name_pattern(github_env):
    accessor, index = github_env
    stdout, io = await find(
        accessor,
        [PathSpec(original="/src", directory="/src", resolved=False)],
        name="*.py",
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    paths = text.strip().splitlines()
    py_files = [p for p in paths if p.endswith(".py")]
    assert len(py_files) >= 3
    assert "/src/main.py" in py_files


@pytest.mark.asyncio
async def test_du_total_size(github_env):
    accessor, index = github_env
    stdout, io = await du(
        accessor,
        [PathSpec(original="/src", directory="/src", resolved=False)],
        s=True,
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    size_str = text.split("\t")[0]
    total = int(size_str)
    assert total > 0


@pytest.mark.asyncio
async def test_stat_file(github_env):
    accessor, index = github_env
    stdout, io = await stat(
        accessor,
        [PathSpec(original="/README.md", directory="/", resolved=True)],
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    assert "name=README.md" in text
    assert "size=500" in text


@pytest.mark.asyncio
async def test_diff_two_files(github_env):
    accessor, index = github_env
    stdout, io = await diff(
        accessor,
        [
            PathSpec(original="/src/models/user.py",
                     directory="/src/models",
                     resolved=True),
            PathSpec(original="/src/models/item.py",
                     directory="/src/models",
                     resolved=True),
        ],
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    assert "---" in text
    assert "+++" in text
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_sed_i_raises(github_env):
    accessor, index = github_env
    with pytest.raises(PermissionError):
        await sed(
            accessor,
            [PathSpec(original="/README.md", directory="/", resolved=True)],
            "s/a/b/",
            i=True,
            index=index,
        )


@pytest.mark.asyncio
async def test_sort_lines(github_env):
    accessor, index = github_env
    stdout, io = await sort_cmd(
        accessor,
        [PathSpec(original="/src/utils.py", directory="/src", resolved=True)],
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    lines = text.splitlines()
    expected = sorted(MOCK_BLOBS["bbb333"].decode().splitlines())
    assert lines == expected


@pytest.mark.asyncio
async def test_tree_depth_1(github_env):
    accessor, index = github_env
    stdout, io = await tree(
        accessor,
        [PathSpec(original="/", directory="/", resolved=False)],
        L="1",
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    assert "README.md" in text
    assert "src" in text
    assert "docs" in text


@pytest.mark.asyncio
async def test_tree_with_prefix(github_env):
    accessor, index = github_env
    stdout, io = await tree(
        accessor,
        [
            PathSpec(original="/gh/",
                     directory="/gh/",
                     resolved=False,
                     prefix="/gh")
        ],
        L="1",
        index=index,
        prefix="/gh",
    )
    data = await materialize(stdout)
    text = data.decode()
    assert "README.md" in text
    assert "src" in text


@pytest.mark.asyncio
async def test_find_type_d(github_env):
    accessor, index = github_env
    stdout, io = await find(
        accessor,
        [PathSpec(original="/", directory="/", resolved=False)],
        type="d",
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    paths = text.strip().splitlines()
    assert any("src" in p for p in paths)
    assert any("docs" in p for p in paths)
    assert not any(p.endswith(".py") for p in paths)


@pytest.mark.asyncio
async def test_find_with_prefix(github_env):
    accessor, index = github_env
    stdout, io = await find(
        accessor,
        [
            PathSpec(original="/gh/src",
                     directory="/gh/src",
                     resolved=False,
                     prefix="/gh")
        ],
        name="*.py",
        index=index,
        prefix="/gh",
    )
    data = await materialize(stdout)
    text = data.decode()
    paths = text.strip().splitlines()
    assert any("/gh/src/main.py" in p for p in paths)


@pytest.mark.asyncio
async def test_rg_single_file(github_env):
    accessor, index = github_env
    stdout, io = await rg(
        accessor,
        [PathSpec(original="/src/main.py", directory="/src/", resolved=True)],
        "import",
        index=index,
    )
    data = await materialize(stdout)
    text = data.decode()
    assert io.exit_code == 0
    lines = text.strip().splitlines()
    assert len(lines) >= 2


@pytest.mark.asyncio
async def test_rg_with_prefix(github_env):
    accessor, index = github_env
    stdout, io = await rg(
        accessor,
        [
            PathSpec(original="/gh/src/main.py",
                     directory="/gh/src/",
                     resolved=True,
                     prefix="/gh")
        ],
        "import",
        index=index,
        prefix="/gh",
    )
    data = await materialize(stdout)
    text = data.decode()
    assert io.exit_code == 0
    assert "import" in text


@pytest.mark.asyncio
async def test_rg_count_stdin_terminates_newline(github_env):
    accessor, index = github_env
    stdout, io = await rg(
        accessor,
        [],
        "foo",
        stdin=b"foo foo\nfoo bar\nbaz\n",
        c=True,
        index=index,
    )
    data = await materialize(stdout)
    assert io.exit_code == 0
    assert data and data.endswith(b"\n")

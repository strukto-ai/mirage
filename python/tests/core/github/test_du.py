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

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mirage.core.github.stat import tree
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.answers import Answers, run_generic

TREE = {
    "Banana.md": TreeEntry("Banana.md", "blob", "s0", 2),
    "docs": TreeEntry("docs", "tree", "s1", None),
    "docs/a.md": TreeEntry("docs/a.md", "blob", "s2", 100),
    "docs/b.md": TreeEntry("docs/b.md", "blob", "s3", 50),
    "docs/c.md": TreeEntry("docs/c.md", "blob", "s5", None),
    "readme.txt": TreeEntry("readme.txt", "blob", "s4", 7),
    "vendor": TreeEntry("vendor", "tree", "s6", None),
}


async def _tree_stat(path):
    entry = TREE.get(path.vfs_path.strip("/"))
    is_file = entry is not None and entry.type == "blob"
    return FileStat(
        name=path.virtual,
        type=FileType.FILE if is_file else FileType.DIRECTORY,
        size=entry.size if is_file else None,
    )


async def _unlisted(path):
    raise AssertionError(f"listed {path.virtual}")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operand,flags,expected",
    [
        ("/", {}, "150\t/docs\n0\t/vendor\n159\t/\n"),
        (
            "/",
            {"a": True},
            "2\t/Banana.md\n100\t/docs/a.md\n50\t/docs/b.md\n"
            "0\t/docs/c.md\n150\t/docs\n7\t/readme.txt\n0\t/vendor\n159\t/\n",
        ),
        ("/docs", {"s": True}, "150\t/docs\n"),
        ("/readme.txt", {"a": True}, "7\t/readme.txt\n"),
    ],
)
async def test_du_sums_the_tree_it_reads_once(
    monkeypatch, operand, flags, expected
):
    monkeypatch.setitem(
        tree.__globals__,
        "refresh_tree",
        AsyncMock(return_value=(TREE, "head")),
    )
    accessor = SimpleNamespace(truncated=False, tree_loaded=False, tree=TREE)

    async def read_tree(path):
        return await tree(accessor, path)

    out, io = await run_generic(
        "du",
        Answers(readdir=_unlisted, stat=_tree_stat, read_tree=read_tree),
        [PathSpec.from_str_path(operand)],
        **flags,
    )
    assert (
        out.decode(),
        io.exit_code,
        await io.stderr_str(),
    ) == (expected, 0, "")

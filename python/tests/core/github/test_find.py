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

from datetime import datetime, timezone

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.find import find
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _accessor() -> GitHubAccessor:
    """A mount whose git tree holds the fixture repository.

    find reads the tree, not the index: the tree keys are repo-relative,
    which is the space find compares in.
    """
    tree = {
        "src":
        TreeEntry(path="src", type="tree", sha="a", size=None),
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="b", size=120),
        "src/utils":
        TreeEntry(path="src/utils", type="tree", sha="c", size=None),
        "src/utils/helpers.py":
        TreeEntry(path="src/utils/helpers.py", type="blob", sha="d", size=80),
        "README.md":
        TreeEntry(path="README.md", type="blob", sha="e", size=50),
    }
    return GitHubAccessor(None, "acme", "proj", "main", "main", tree=tree)


def _spec(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(vfs_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path)


@pytest.mark.asyncio
async def test_find_all_from_root():
    results = await find(_accessor(), _spec("/"))
    assert results == [
        "/", "/README.md", "/src", "/src/main.py", "/src/utils",
        "/src/utils/helpers.py"
    ]


@pytest.mark.asyncio
async def test_find_name_pattern():
    results = await find(_accessor(), _spec("/"), name="*.py")
    assert results == ["/src/main.py", "/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_type_directory():
    results = await find(_accessor(), _spec("/src"), type="d")
    assert results == ["/src", "/src/utils"]


@pytest.mark.asyncio
async def test_find_type_file_under_subdir():
    results = await find(_accessor(), _spec("/src"), type="f")
    assert results == ["/src/main.py", "/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_maxdepth():
    results = await find(_accessor(), _spec("/src"), maxdepth=1)
    assert results == ["/src", "/src/main.py", "/src/utils"]


@pytest.mark.asyncio
async def test_find_mindepth():
    results = await find(_accessor(), _spec("/src"), mindepth=2)
    assert results == ["/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_strips_mount_prefix():
    results = await find(_accessor(),
                         _spec("/github/src", prefix="/github"),
                         type="f")
    assert results == ["/src/main.py", "/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_size_filters():
    # Directories contribute size 0 to -size, so the root is excluded
    # under a positive minimum (#318).
    results = await find(_accessor(), _spec("/"), min_size=100)
    assert results == ["/src/main.py"]


@pytest.mark.asyncio
async def test_find_file_start_path():
    results = await find(_accessor(), _spec("/src/main.py"))
    assert results == ["/src/main.py"]


@pytest.mark.asyncio
async def test_find_size_filters_file_start():
    too_big = await find(_accessor(), _spec("/src/main.py"), max_size=50)
    assert too_big == []
    big_enough = await find(_accessor(), _spec("/src/main.py"), min_size=100)
    assert big_enough == ["/src/main.py"]


@pytest.mark.asyncio
async def test_find_mtime_excludes_every_entry_a_git_tree_has_no_times():
    # A git tree carries no timestamps, so every entry's mtime is unknown
    # and -mtime excludes it. This was already true through the index,
    # which nothing ever gave a remote_time.
    results = await find(
        _accessor(),
        _spec("/"),
        mtime_min=datetime(2026, 7, 15, tzinfo=timezone.utc).timestamp(),
        mtime_max=datetime(2026, 7, 16, tzinfo=timezone.utc).timestamp(),
    )

    assert results == []


@pytest.mark.asyncio
async def test_find_empty_matches_empty_files_and_directories():
    accessor = _accessor()
    accessor.tree["empty.txt"] = TreeEntry(path="empty.txt",
                                           type="blob",
                                           sha="empty-file",
                                           size=0)
    accessor.tree["empty-dir"] = TreeEntry(path="empty-dir",
                                           type="tree",
                                           sha="empty-dir",
                                           size=None)

    results = await find(accessor, _spec("/"), empty=True)

    assert results == ["/empty-dir", "/empty.txt"]

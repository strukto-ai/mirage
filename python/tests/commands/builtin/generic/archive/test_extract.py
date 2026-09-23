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

from mirage.commands.builtin.generic.archive.extract import (dir_exists,
                                                             ensure_dir,
                                                             extract_dest)
from mirage.types import FileStat, FileType, PathSpec


def test_extract_dest_prefers_the_explicit_operand():
    explicit = PathSpec.from_str_path("/work/out")
    cwd = PathSpec.from_str_path("/elsewhere")
    assert extract_dest(explicit, cwd, True) == "/work/out"


def test_extract_dest_falls_back_to_cwd_per_space():
    cwd = PathSpec(virtual="/work/sub", directory="/work/sub", vfs_path="sub")
    assert extract_dest(None, cwd, True) == "/work/sub"
    assert extract_dest(None, cwd, False) == "/sub"


def test_extract_dest_string_cwd_defaults_to_root():
    assert extract_dest(None, "", False) == "/"
    assert extract_dest(None, "/w", True) == "/w"


def _stat_factory(dirs: set[str]):

    async def stat(path: PathSpec) -> FileStat:
        if path.virtual in dirs:
            return FileStat(path=path.virtual,
                            name=path.virtual.rsplit("/", 1)[-1],
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(path.virtual)

    return stat


def test_ensure_dir_creates_only_missing_levels():
    created: list[str] = []

    async def mkdir(path: PathSpec) -> None:
        created.append(path.virtual)

    made: set[str] = set()
    asyncio.run(ensure_dir("/work/a/b", mkdir, _stat_factory({"/work"}), made))
    assert created == ["/work/a", "/work/a/b"]
    assert made == {"/work", "/work/a", "/work/a/b"}


def test_ensure_dir_memoizes_across_members():
    calls: list[str] = []

    async def mkdir(path: PathSpec) -> None:
        calls.append(path.virtual)

    made: set[str] = set()
    stat = _stat_factory(set())
    asyncio.run(ensure_dir("/a/b", mkdir, stat, made))
    asyncio.run(ensure_dir("/a/b/c", mkdir, stat, made))
    assert calls == ["/a", "/a/b", "/a/b/c"]


def test_dir_exists_answers_false_on_a_miss():
    stat = _stat_factory(set())
    assert asyncio.run(dir_exists(stat, "/nope")) is False
    stat = _stat_factory({"/yes"})
    assert asyncio.run(dir_exists(stat, "/yes")) is True

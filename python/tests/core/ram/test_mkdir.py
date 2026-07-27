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

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.mkdir_p import mkdir_p
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_mkdir():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir(
        a,
        PathSpec(resource_path="newdir",
                 virtual="/newdir",
                 directory="/newdir"))
    assert "/newdir" in s.dirs
    assert "/newdir" in s.modified


@pytest.mark.asyncio
async def test_mkdir_parent_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    # The operand is what a GNU stderr line names, so the error carries the
    # virtual path, not the internal "parent does not exist" phrasing.
    with pytest.raises(FileNotFoundError, match="/no/parent"):
        await mkdir(
            a,
            PathSpec(resource_path="no/parent",
                     virtual="/no/parent",
                     directory="/no/parent"))
    assert "/no/parent" not in s.dirs


@pytest.mark.asyncio
async def test_mkdir_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await mkdir(
            a,
            PathSpec(resource_path="plain/sub",
                     virtual="/plain/sub",
                     directory="/plain/sub"))
    assert "/plain/sub" not in s.dirs


@pytest.mark.asyncio
async def test_mkdir_deep_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await mkdir(
            a,
            PathSpec(resource_path="plain/sub/deeper",
                     virtual="/plain/sub/deeper",
                     directory="/plain/sub/deeper"))


@pytest.mark.asyncio
async def test_mkdir_already_exists_needs_parents_to_be_idempotent():
    s = RAMStore()

    a = RAMAccessor(s)
    spec = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
    await mkdir(a, spec)
    # Only -p is idempotent; plain mkdir refuses an existing target (GNU).
    with pytest.raises(FileExistsError):
        await mkdir(a, spec)
    await mkdir(a, spec, parents=True)
    assert "/dir" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p_across_a_file_names_the_component():
    s = RAMStore()
    s.dirs.add("/")
    s.dirs.add("/g")
    s.files["/g/a.txt"] = b"hi"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError) as excinfo:
        await mkdir(a,
                    PathSpec(resource_path="g/a.txt/sub",
                             virtual="/g/a.txt/sub",
                             directory="/g/a.txt/sub"),
                    parents=True)
    # GNU quotes the component it tripped on, not the operand, and the file
    # it collided with is left alone.
    assert str(excinfo.value) == "/g/a.txt"
    assert "/g/a.txt" not in s.dirs
    assert s.files["/g/a.txt"] == b"hi"


@pytest.mark.asyncio
async def test_mkdir_p_stops_at_the_first_bad_component():
    s = RAMStore()
    s.dirs.add("/")
    s.files["/a.txt"] = b"hi"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError) as excinfo:
        await mkdir(a,
                    PathSpec(resource_path="a.txt/x/y/z",
                             virtual="/a.txt/x/y/z",
                             directory="/a.txt/x/y/z"),
                    parents=True)
    assert str(excinfo.value) == "/a.txt"


@pytest.mark.asyncio
async def test_mkdir_p_onto_a_file_target_is_eexist():
    s = RAMStore()
    s.dirs.add("/")
    s.files["/a.txt"] = b"hi"

    a = RAMAccessor(s)
    with pytest.raises(FileExistsError, match="/a.txt"):
        await mkdir(a,
                    PathSpec(resource_path="a.txt",
                             virtual="/a.txt",
                             directory="/a.txt"),
                    parents=True)


@pytest.mark.asyncio
async def test_mkdir_refuses_an_existing_file():
    s = RAMStore()
    s.dirs.add("/")
    s.files["/a.txt"] = b"hi"

    a = RAMAccessor(s)
    with pytest.raises(FileExistsError, match="/a.txt"):
        await mkdir(
            a,
            PathSpec(resource_path="a.txt",
                     virtual="/a.txt",
                     directory="/a.txt"))
    assert s.files["/a.txt"] == b"hi"


@pytest.mark.asyncio
async def test_mkdir_with_parents():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir(a,
                PathSpec(resource_path="a/b/c",
                         virtual="/a/b/c",
                         directory="/a/b/c"),
                parents=True)
    assert "/a" in s.dirs
    assert "/a/b" in s.dirs
    assert "/a/b/c" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir_p(a, PathSpec.from_str_path("/x/y/z"))
    assert "/x" in s.dirs
    assert "/x/y" in s.dirs
    assert "/x/y/z" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p_existing_parent():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/existing")
    await mkdir_p(a, PathSpec.from_str_path("/existing/child/grandchild"))
    assert "/existing/child" in s.dirs
    assert "/existing/child/grandchild" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p_does_not_overwrite_modified():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir_p(a, PathSpec.from_str_path("/a"))
    original_modified = s.modified["/a"]
    await mkdir_p(a, PathSpec.from_str_path("/a/b"))
    assert s.modified["/a"] == original_modified

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

from mirage.core.tidb_filesystem.dest import (
    broken_parent,
    check_mkdir_target,
    check_rename,
    check_write_target,
    lookup_error,
)
from mirage.core.tidb_filesystem.types import Entry
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

ROOT = Entry("/", True, 0, None)
DIR = Entry("d", True, 0, None)
FILE = Entry("f", False, 1, None)


def spec(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


def test_broken_parent_stops_at_the_first_gap():
    kinds = {"/": ROOT, "/a": None, "/a/b": FILE}

    error = broken_parent(kinds, spec("/fs/a/b/c"), "/a/b/c")

    assert isinstance(error, FileNotFoundError)


def test_a_folder_beside_a_file_of_its_name_is_a_folder_above():
    kinds = {"/": ROOT, "/a": FILE, "/a/": DIR}

    assert broken_parent(kinds, spec("/fs/a/b"), "/a/b") is None


def test_lookup_error_names_a_file_above():
    kinds = {"/": ROOT, "/a": FILE}

    assert isinstance(
        lookup_error(kinds, spec("/fs/a/x"), "/a/x"), NotADirectoryError
    )


def test_write_onto_a_directory_is_eisdir():
    with pytest.raises(IsADirectoryError):
        check_write_target({"/": ROOT, "/d": DIR}, spec("/fs/d"), "/d")


def test_plain_mkdir_on_anything_is_eexist():
    with pytest.raises(FileExistsError):
        check_mkdir_target(
            {"/": ROOT, "/f": FILE}, spec("/fs/f"), "/f", parents=False
        )


def test_mkdir_p_names_the_file_it_crosses():
    kinds = {"/": ROOT, "/f": FILE, "/f/sub": None}

    with pytest.raises(NotADirectoryError) as raised:
        check_mkdir_target(kinds, spec("/fs/f/sub"), "/f/sub", parents=True)

    assert raised.value.filename == "/fs/f"


def test_mkdir_p_on_a_directory_is_done():
    assert check_mkdir_target(
        {"/": ROOT, "/d": DIR}, spec("/fs/d"), "/d", parents=True
    )


@pytest.mark.parametrize(
    ("kinds", "src", "dst", "error"),
    [
        ({"/f": FILE, "/d": DIR}, "/f", "/d", IsADirectoryError),
        ({"/d": DIR, "/f": FILE}, "/d", "/f", NotADirectoryError),
        ({"/d": DIR, "/d/in": None}, "/d", "/d/in", OSError),
        ({"/f": FILE, "/x": None, "/x/y": None}, "/f", "/x/y", OSError),
        ({"/f": None, "/g": None}, "/f", "/g", FileNotFoundError),
    ],
)
def test_rename_refusals(kinds, src, dst, error):
    with pytest.raises(error):
        check_rename(
            {"/": ROOT, **kinds},
            spec("/fs" + src),
            src,
            spec("/fs" + dst),
            dst,
        )

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

import pytest

from mirage.core.github.scope import (count_scope_files, is_repo_root,
                                      scope_relative_key)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def entries():

    def _f():
        return SimpleNamespace(resource_type="file")

    def _d():
        return SimpleNamespace(resource_type="folder")

    return {
        "/README.md": _f(),
        "/src": _d(),
        "/src/main.py": _f(),
        "/src/utils.py": _f(),
        "/src/models": _d(),
        "/src/models/user.py": _f(),
    }


def test_scope_relative_key_strips_mount_prefix():
    path = PathSpec(resource_path=mount_key("/gh/src", "/gh"),
                    virtual="/gh/src",
                    directory="/gh/src")
    assert scope_relative_key(path) == "/src"


def test_scope_relative_key_root_becomes_slash():
    path = PathSpec(resource_path=mount_key("/gh", "/gh"),
                    virtual="/gh",
                    directory="/gh")
    assert scope_relative_key(path) == "/"


def test_is_repo_root():
    assert is_repo_root("/")
    assert is_repo_root("")
    assert not is_repo_root("/src")


def test_count_scope_files_root_counts_all(entries):
    assert count_scope_files(entries, "/") == 4


def test_count_scope_files_subdir(entries):
    assert count_scope_files(entries, "/src") == 3


def test_count_scope_files_single_file(entries):
    assert count_scope_files(entries, "/src/main.py") == 1


def test_count_scope_files_missing(entries):
    assert count_scope_files(entries, "/nope") == 0

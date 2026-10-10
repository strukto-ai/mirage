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

from mirage.core.github.pushdown import (
    count_scope_files,
    scope_blobs,
    scope_relative_key,
    search_safe,
    unsearchable_keys,
)
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def entries():
    """A git tree, keyed repo-relative with no leading slash."""

    def _f():
        return SimpleNamespace(type="blob")

    def _d():
        return SimpleNamespace(type="tree")

    return {
        "README.md": _f(),
        "src": _d(),
        "src/main.py": _f(),
        "src/utils.py": _f(),
        "src/models": _d(),
        "src/models/user.py": _f(),
    }


def test_scope_relative_key_strips_mount_prefix():
    path = PathSpec(
        vfs_path=mount_key("/gh/src", "/gh"),
        virtual="/gh/src",
        directory="/gh/src",
    )
    assert scope_relative_key(path) == "/src"


def test_scope_relative_key_root_becomes_slash():
    path = PathSpec(
        vfs_path=mount_key("/gh", "/gh"), virtual="/gh", directory="/gh"
    )
    assert scope_relative_key(path) == "/"


def test_count_scope_files_root_counts_all(entries):
    assert count_scope_files(entries, "/") == 4


def test_count_scope_files_subdir(entries):
    assert count_scope_files(entries, "/src") == 3


def test_count_scope_files_single_file(entries):
    assert count_scope_files(entries, "/src/main.py") == 1


def test_count_scope_files_missing(entries):
    assert count_scope_files(entries, "/nope") == 0


def test_scope_blobs_lists_the_files_at_or_below_a_key(entries):
    # Tree order, files only; the root key is every file, a file key is
    # itself, and a sibling sharing the spelling (srcx/) is outside.
    entries["srcx/other.py"] = entries["src/main.py"]
    assert [p for p, _ in scope_blobs(entries, "/")] == [
        "README.md",
        "src/main.py",
        "src/utils.py",
        "src/models/user.py",
        "srcx/other.py",
    ]
    assert [p for p, _ in scope_blobs(entries, "/src")] == [
        "src/main.py",
        "src/utils.py",
        "src/models/user.py",
    ]
    assert [p for p, _ in scope_blobs(entries, "/src/main.py")] == [
        "src/main.py"
    ]
    assert scope_blobs(entries, "/nope") == []


# Measured against api.github.com on 2026-09-25: a `name:` word is a
# qualifier, a quote starts a phrase, a word-leading `-` negates and `NOT` is
# an operator, each narrowing the answer; lowercase `not` and `OR` are plain
# terms. Word characters are ASCII here, the same rule the TypeScript twin
# applies, so the two hosts gate the same literals.
@pytest.mark.parametrize(
    "query",
    [
        "foo path:docs",
        'say "hi"',
        "foo -bar",
        "-foo",
        "foo NOT bar",
        "NOT",
        "a\tNOT\tb",
        "   ",
        "\t",
        "a\x1c-b",
        "a\ufeff-b",
        "x(-y",
        "\u00e9-b",
        "\u00e9NOT x",
        "\u00e9",
    ],
)
def test_search_safe_refuses_a_literal_that_narrows_the_search(query):
    assert not search_safe(query)


@pytest.mark.parametrize(
    "query",
    [
        "foo",
        "foo bar",
        "foo-bar",
        "not",
        "OR",
        "NOTE",
        "NOTHING x",
        "a_NOT",
    ],
)
def test_search_safe_accepts_plain_terms(query):
    assert search_safe(query)


def test_unsearchable_keys_lists_what_code_search_never_indexes():
    limit = 384 * 1024

    def blob(path, size):
        return TreeEntry(path=path, type="blob", sha=path, size=size)

    tree = {
        "src": TreeEntry(path="src", type="tree", sha="t", size=None),
        "src/big.bin": blob("src/big.bin", limit),
        "src/edge.py": blob("src/edge.py", limit - 1),
        "src/none.py": blob("src/none.py", None),
        "docs/big.md": blob("docs/big.md", limit + 1),
        "srcx/big.bin": blob("srcx/big.bin", limit),
    }
    # srcx/ shares src's spelling but is not under it.
    assert unsearchable_keys(tree, "/src") == ["src/big.bin", "src/none.py"]
    assert unsearchable_keys(tree, "/") == [
        "docs/big.md",
        "src/big.bin",
        "src/none.py",
        "srcx/big.bin",
    ]

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

from mirage.accessor.hf_hub import HfHubAccessor, HfRepoConfig


class ModelAccessor(HfHubAccessor):
    REPO_TYPE = "model"
    VFS_NAME = "hf_models"


def test_revision_defaults_to_main_without_a_request():
    """Unlike GitHub's default branch, the Hub creates every repository
    with `main` and offers no way to change which branch is default, so
    naming no revision costs nothing to resolve."""
    assert ModelAccessor(HfRepoConfig(repo_id="a/b")).revision == "main"


def test_revision_honours_an_explicit_pin():
    acc = ModelAccessor(HfRepoConfig(repo_id="a/b", revision="v2"))
    assert acc.revision == "v2"


def test_key_prefix_is_normalized_with_a_trailing_slash():
    acc = ModelAccessor(HfRepoConfig(repo_id="a/b", key_prefix="/sub/dir"))
    assert acc.key_prefix == "sub/dir/"


def test_key_prefix_is_empty_when_unset():
    assert ModelAccessor(HfRepoConfig(repo_id="a/b")).key_prefix == ""


@pytest.mark.parametrize("prefix,local,expected", [
    (None, "/a.txt", "a.txt"),
    (None, "/d/a.txt", "d/a.txt"),
    (None, "/", ""),
    ("sub/dir", "/a.txt", "sub/dir/a.txt"),
    ("sub/dir", "/", "sub/dir"),
])
def test_repo_path_joins_the_prefix_exactly_once(prefix, local, expected):
    """The prefix is normalized with a trailing slash, so a hand-written
    join produced `sub/dir//a.txt` and 404'd every prefixed read."""
    acc = ModelAccessor(HfRepoConfig(repo_id="a/b", key_prefix=prefix))
    assert acc.repo_path(local) == expected


def test_expand_commits_defaults_to_deciding_by_size():
    assert ModelAccessor(HfRepoConfig(repo_id="a/b")).expand_commits is None


def test_a_fresh_accessor_has_hydrated_nothing():
    acc = ModelAccessor(HfRepoConfig(repo_id="a/b"))
    assert acc.tree == {}
    assert acc.tree_loaded is False
    assert acc.rows_cache is None

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

from mirage.core.hf_hub.cache import (
    blob_path,
    cache_root,
    etag_of,
    link_target,
    ref_path,
    repo_folder_name,
    snapshot_dir,
    snapshot_path,
)
from mirage.core.hf_hub.tree_entry import TreeEntry
from mirage.types import PathSpec


def entry(path: str, oid: str = "oid1", lfs: str = "") -> TreeEntry:
    return TreeEntry(
        path=path,
        type="file",
        oid=oid,
        size=3,
        last_modified="",
        last_commit="",
        lfs_oid=lfs,
        xet_hash="",
    )


@pytest.mark.parametrize(
    "repo_id,repo_type,expected",
    [
        (
            "julien-c/EsperBERTo-small",
            "model",
            "models--julien-c--EsperBERTo-small",
        ),
        ("acme/rows", "dataset", "datasets--acme--rows"),
        ("acme/demo", "space", "spaces--acme--demo"),
    ],
)
def test_repo_folder_name_matches_upstream(repo_id, repo_type, expected):
    """Upstream's own spelling: the plural kind and the id's halves
    joined by `--`, flattened so a namespace cannot nest and two repos
    cannot collide across kinds."""
    assert repo_folder_name(repo_id, repo_type) == expected


def test_etag_prefers_the_lfs_sha():
    """Upstream keys a blob by the ETag the resolve endpoint answered:
    the LFS sha256 for a pointer-backed file, the git oid otherwise."""
    assert etag_of(entry("a.bin", oid="git1", lfs="lfs1")) == "lfs1"
    assert etag_of(entry("a.txt", oid="git1")) == "git1"


def test_layout_paths():
    folder = repo_folder_name("acme/w", "model")
    assert (
        blob_path(PathSpec.from_str_path("/c"), folder, "e1").virtual
        == "/c/models--acme--w/blobs/e1"
    )
    assert (
        ref_path(PathSpec.from_str_path("/c"), folder, "main").virtual
        == "/c/models--acme--w/refs/main"
    )
    assert (
        snapshot_dir(PathSpec.from_str_path("/c"), folder, "sha").virtual
        == "/c/models--acme--w/snapshots/sha"
    )
    assert snapshot_path(
        PathSpec.from_str_path("/c"), folder, "sha", "sub/b.json"
    ).virtual == ("/c/models--acme--w/snapshots/sha/sub/b.json")


@pytest.mark.parametrize(
    "repo_path,expected",
    [
        ("a.txt", "../../blobs/e1"),
        ("sub/b.json", "../../../blobs/e1"),
        ("sub/deep/c.bin", "../../../../blobs/e1"),
    ],
)
def test_link_target_is_relative_to_the_entry(repo_path, expected):
    """Relative because upstream's cache is relocatable: the whole
    directory can be moved and every link still resolves."""
    folder = repo_folder_name("acme/w", "model")
    assert (
        link_target(
            PathSpec.from_str_path("/c"), folder, "sha", repo_path, "e1"
        )
        == expected
    )


def test_cache_root_reads_upstream_order():
    assert cache_root({"HF_HUB_CACHE": "/x"}) == "/x"
    assert cache_root({"HF_HOME": "/h"}) == "/h/hub"
    assert cache_root({"HF_HUB_CACHE": "/x", "HF_HOME": "/h"}) == "/x"


def test_cache_root_reports_that_nothing_named_one():
    """A workspace has no home directory, so upstream's last fallback
    is the step that cannot be taken; the caller reports it rather than
    inventing a path."""
    assert cache_root({}) is None
    assert cache_root(None) is None


def test_cache_paths_keep_the_roots_directory_walk():
    root = PathSpec.from_str_path("/hidden/../cache", cwd="/")
    blob = blob_path(root, "models--acme--w", "e1")
    assert blob.virtual == "/cache/models--acme--w/blobs/e1"
    assert blob.dotted == "/hidden/../cache/models--acme--w/blobs/e1"

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

from mirage.types import PathSpec
from mirage.utils.key_prefix import (
    child_spec,
    mount_key,
    normalize,
    outermost,
    rekey,
    strip_mount,
    under_path,
)
from mirage.vfs.gridfs import GridFSConfig
from mirage.vfs.hf_buckets.config import HfBucketsConfig, HfRepoConfig
from mirage.vfs.r2 import R2Config
from mirage.vfs.s3 import S3Config

# The one key-prefix rule, mirrored by
# typescript/packages/core/src/utils/key_prefix.test.ts. A root-spelled
# prefix is no prefix: "/" used to normalize to "/", and every s3 or gridfs
# key then began with a slash.
NORMALIZE = [
    ("/team/x/", "team/x/"),
    ("team/x", "team/x/"),
    ("//team/x", "team/x/"),
    ("", ""),
    (None, ""),
    ("/", ""),
    ("//", ""),
]


@pytest.mark.parametrize("raw,expected", NORMALIZE)
def test_normalize(raw, expected):
    assert normalize(raw) == expected


# Every config that keys objects under a prefix stores `normalize(raw)`, so
# one spelling names one prefix whichever backend it reaches; an alias
# reaches it through the S3Config it converts to.
PREFIX_CONFIGS = {
    "s3": lambda raw: S3Config(bucket="b", key_prefix=raw),
    "r2": lambda raw: R2Config(
        bucket="b", account_id="a", key_prefix=raw
    ).to_s3_config(),
    "gridfs": lambda raw: GridFSConfig(
        uri="mongodb://h", database="d", key_prefix=raw
    ),
    "hf_buckets": lambda raw: HfBucketsConfig(bucket="o/b", key_prefix=raw),
    "hf_models": lambda raw: HfRepoConfig(repo_id="o/r", key_prefix=raw),
}


@pytest.mark.parametrize("name", sorted(PREFIX_CONFIGS))
@pytest.mark.parametrize("raw,expected", NORMALIZE)
def test_every_object_key_config_stores_the_normalized_prefix(
    name, raw, expected
):
    assert (PREFIX_CONFIGS[name](raw).key_prefix or "") == expected


def test_strip_mount_removes_prefix_at_boundary():
    assert strip_mount("/data/sub/x.txt", "/data") == "/sub/x.txt"


def test_strip_mount_respects_path_boundary():
    assert strip_mount("/database/x.txt", "/data") == "/database/x.txt"


def test_strip_mount_at_mount_root():
    assert strip_mount("/data", "/data") == "/"


def test_strip_mount_without_prefix():
    assert strip_mount("/x.txt", "") == "/x.txt"


def test_mount_key_strips_surrounding_slashes():
    assert mount_key("/data/sub/x.txt", "/data") == "sub/x.txt"


def test_mount_key_at_mount_root_is_empty():
    assert mount_key("/data", "/data") == ""


def test_mount_key_without_prefix():
    assert mount_key("/x.txt", "") == "x.txt"


def test_under_path_matches_descendant():
    assert under_path("/data/x/y", "/data/x") is True


def test_under_path_matches_root_itself():
    assert under_path("/data/x", "/data/x") is True


def test_under_path_ignores_trailing_slash_on_either_side():
    assert under_path("/data/x/", "/data/x") is True
    assert under_path("/data/x", "/data/x/") is True


def test_under_path_respects_path_boundary():
    assert under_path("/data/xy", "/data/x") is False


def test_under_path_with_empty_root_matches_everything():
    assert under_path("/anything", "") is True
    assert under_path("/anything", "/") is True


def test_rekey_child_under_named_mount():
    assert rekey("/data/sub", "sub", "/data/sub/x.txt") == "sub/x.txt"


def test_rekey_child_at_mount_root():
    assert rekey("/data", "", "/data/x.txt") == "x.txt"


def test_rekey_deep_child():
    assert rekey("/mnt/s3", "", "/mnt/s3/a/b/c.txt") == "a/b/c.txt"


def test_rekey_matches_mount_key():
    parent_original = "/data/sub"
    prefix = "/data"
    parent_key = mount_key(parent_original, prefix)
    child = "/data/sub/deep/y.txt"
    assert rekey(parent_original, parent_key, child) == mount_key(
        child, prefix
    )


def test_child_spec_appends_to_the_vfs_key():
    parent = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    child = child_spec(parent, "x")
    assert child.virtual == "/m/d/x"
    assert child.vfs_path == "d/x"
    root = PathSpec(virtual="/m", directory="/", vfs_path="")
    assert child_spec(root, "x").vfs_path == "x"


def test_outermost_keeps_the_paths_no_other_sits_below():
    paths = [
        PathSpec.from_str_path(p)
        for p in ("/d/s", "/d", "/e", "/dx", "/d-x", "/d-x/y")
    ]
    assert [p.virtual for p in outermost(paths)] == ["/d", "/e", "/dx", "/d-x"]

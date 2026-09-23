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
from contextlib import ExitStack

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.readdir import readdir
from mirage.types import PathSpec
from mirage.vfs.s3 import S3Config
from tests.e2e.s3_mock import patch_s3_multi

_TREE = {
    "a.txt": b"file",
    "dir/f.txt": b"child",
    "dir/sub/g.txt": b"deeper",
    "empty/": b"",
}


def _accessor(key_prefix: str | None = None) -> S3Accessor:
    return S3Accessor(
        S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
            key_prefix=key_prefix,
        ))


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    vfs_path=virtual.strip("/"))


def _readdir(store: dict[str, bytes], virtual: str, key_prefix: str = ""):
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        return asyncio.run(
            readdir(_accessor(key_prefix or None), _path(virtual)))
    finally:
        stack.close()


def test_readdir_lists_a_prefix():
    assert _readdir(_TREE, "/dir") == ["/dir/f.txt", "/dir/sub"]


def test_readdir_marker_only_directory_is_empty_not_missing():
    # The zero-byte "empty/" object is the only trace an empty directory
    # leaves, and it must read as an empty listing rather than ENOENT.
    assert _readdir(_TREE, "/empty") == []


def test_readdir_root_of_an_empty_bucket_does_not_raise():
    assert _readdir({}, "/") == []


def test_readdir_missing_path_is_enoent():
    with pytest.raises(FileNotFoundError):
        _readdir(_TREE, "/never.txt")


def test_readdir_missing_nested_path_is_enoent():
    with pytest.raises(FileNotFoundError):
        _readdir(_TREE, "/nodir/deep")


def test_readdir_on_an_object_is_enotdir():
    with pytest.raises(NotADirectoryError):
        _readdir(_TREE, "/a.txt")


def test_readdir_below_an_object_is_enotdir():
    with pytest.raises(NotADirectoryError):
        _readdir(_TREE, "/a.txt/x")


def test_readdir_missing_path_under_a_key_prefix_is_enoent():
    store = {"team/dir/f.txt": b"child"}
    with pytest.raises(FileNotFoundError):
        _readdir(store, "/never.txt", key_prefix="team")


def test_readdir_key_prefix_root_does_not_raise():
    assert _readdir({}, "/", key_prefix="team") == []


def test_readdir_missing_child_of_a_coexisting_object_and_prefix():
    # S3 allows an object "a" and a prefix "a/" at once, and a child path
    # reaches "a" only through the prefix, so a missing child is ENOENT.
    store = {"a": b"i am a file", "a/x.txt": b"child"}
    with pytest.raises(FileNotFoundError):
        _readdir(store, "/a/never")


def test_readdir_coexisting_prefix_still_lists_its_children():
    store = {"a": b"i am a file", "a/x.txt": b"child"}
    assert _readdir(store, "/a") == ["/a/x.txt"]

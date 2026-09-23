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
import errno
from contextlib import ExitStack

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.rm import rm_r
from mirage.core.s3.rmdir import rmdir
from mirage.types import PathSpec
from mirage.vfs.s3 import S3Config
from tests.e2e.s3_mock import patch_s3_multi


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


def _run(fn, store: dict[str, bytes], virtual: str, key_prefix: str = ""):
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({"test-bucket": store}))
    try:
        return asyncio.run(fn(_accessor(key_prefix or None), _path(virtual)))
    finally:
        stack.close()


def test_rmdir_refuses_a_nonempty_prefix_and_keeps_every_key():
    store = {"dir/": b"", "dir/f.txt": b"child", "dir/sub/g.txt": b"deeper"}
    with pytest.raises(OSError) as excinfo:
        _run(rmdir, store, "/dir")
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert store == {
        "dir/": b"",
        "dir/f.txt": b"child",
        "dir/sub/g.txt": b"deeper",
    }


def test_rmdir_refuses_a_prefix_whose_only_child_is_a_subdirectory():
    store = {"dir/": b"", "dir/sub/": b""}
    with pytest.raises(OSError) as excinfo:
        _run(rmdir, store, "/dir")
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert store == {"dir/": b"", "dir/sub/": b""}


def test_rmdir_removes_the_marker_of_an_empty_prefix():
    store = {"dir/": b"", "other.txt": b"keep"}
    _run(rmdir, store, "/dir")
    assert store == {"other.txt": b"keep"}


def test_rmdir_on_a_prefix_holding_no_key_is_enoent():
    store = {"other.txt": b"keep"}
    with pytest.raises(FileNotFoundError):
        _run(rmdir, store, "/nope")
    assert store == {"other.txt": b"keep"}


def test_rmdir_honors_the_mount_key_prefix():
    store = {"tenant/dir/": b"", "tenant/dir/f.txt": b"child"}
    with pytest.raises(OSError) as excinfo:
        _run(rmdir, store, "/dir", key_prefix="tenant")
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert store == {"tenant/dir/": b"", "tenant/dir/f.txt": b"child"}


def test_rm_r_still_deletes_the_whole_subtree():
    store = {"dir/": b"", "dir/f.txt": b"child", "keep.txt": b"keep"}
    _run(rm_r, store, "/dir")
    assert store == {"keep.txt": b"keep"}

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
from mirage.core.s3.rename import rename
from mirage.types import PathSpec
from mirage.vfs.s3 import S3Config
from tests.e2e.s3_mock import (MultiBucketSession, patch_s3_multi,
                               patch_s3_session)

BUCKET = "test-bucket"


def _config(key_prefix: str | None = None) -> S3Config:
    return S3Config(
        bucket=BUCKET,
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
        **({
            "key_prefix": key_prefix
        } if key_prefix else {}),
    )


def _spec(key: str) -> PathSpec:
    return PathSpec(vfs_path=key,
                    virtual=f"/{key}",
                    directory="/" +
                    key.rsplit("/", 1)[0] if "/" in key else "/")


def _run(store: dict, config: S3Config, src: str, dst: str) -> None:
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({BUCKET: store}))
    try:
        asyncio.run(rename(S3Accessor(config), _spec(src), _spec(dst)))
    finally:
        stack.close()


def test_rename_moves_a_whole_directory_prefix():
    """A directory owns no object, so the prefix walk has to carry it.

    The regression this pins reported the raw botocore text ("An error
    occurred (NoSuchKey) when calling the CopyObject operation") because
    the copy targeted the directory's own key.
    """
    store = {
        "d/": b"",
        "d/f.txt": b"hi",
        "d/sub/g.txt": b"deep",
        "keep.txt": b"untouched",
    }
    _run(store, _config(), "d", "e")
    assert sorted(store) == ["e/", "e/f.txt", "e/sub/g.txt", "keep.txt"]
    assert store["e/f.txt"] == b"hi"
    assert store["e/sub/g.txt"] == b"deep"
    assert store["keep.txt"] == b"untouched"


def test_rename_moves_a_directory_under_a_key_prefix():
    """The mount's key_prefix rides on both sides of the walk.

    A prefixed mount is where an off-by-one in the key rewrite shows up,
    since the stored key and the mount-relative path differ.
    """
    store = {
        "team/d/": b"",
        "team/d/f.txt": b"hi",
        "team/other.txt": b"untouched",
    }
    _run(store, _config("team"), "d", "e")
    assert sorted(store) == ["team/e/", "team/e/f.txt", "team/other.txt"]
    assert store["team/e/f.txt"] == b"hi"


def test_rename_keeps_moving_a_plain_file():
    store = {"a.txt": b"payload"}
    _run(store, _config(), "a.txt", "b.txt")
    assert sorted(store) == ["b.txt"]
    assert store["b.txt"] == b"payload"


def test_rename_missing_source_is_enoent_not_a_backend_error():
    """A raw backend error must never reach the user as itself."""
    store = {"other.txt": b"x"}
    with pytest.raises(FileNotFoundError):
        _run(store, _config(), "ghost", "e")
    assert sorted(store) == ["other.txt"]


def test_rename_reports_a_refused_delete_instead_of_claiming_success():
    """DeleteObjects refuses per key inside a 200, and never raises.

    Reading only the absence of an exception would leave the whole source
    tree beside the fresh copy and still call the move a success, which is
    a duplicated directory the caller is never told about.
    """
    store = {"d/": b"", "d/f.txt": b"hi", "d/locked.txt": b"no"}
    session = MultiBucketSession({BUCKET: store})
    session._client.undeletable.add("d/locked.txt")
    stack = ExitStack()
    stack.enter_context(patch_s3_session(session))
    try:
        with pytest.raises(PermissionError):
            asyncio.run(rename(S3Accessor(_config()), _spec("d"), _spec("e")))
    finally:
        stack.close()
    # Both trees survive, the way GNU mv leaves them when the unlink half
    # fails after the copy half landed.
    assert "d/locked.txt" in store
    assert store["e/f.txt"] == b"hi"

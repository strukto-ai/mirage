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
from mirage.core.s3.copy import copy
from mirage.core.s3.rename import rename
from mirage.resource.s3 import S3Config
from mirage.types import PathSpec
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
    return PathSpec(resource_path=key,
                    virtual=f"/{key}",
                    directory="/" +
                    key.rsplit("/", 1)[0] if "/" in key else "/")


def _run(fn, store: dict, config: S3Config):
    stack = ExitStack()
    stack.enter_context(patch_s3_multi({BUCKET: store}))
    try:
        return asyncio.run(fn(S3Accessor(config)))
    finally:
        stack.close()


def test_rename_onto_the_same_key_keeps_the_object():
    """The data-loss shape #150 describes.

    The mock accepts a self-copy, like a non-AWS S3-compatible store
    might. Without the guard the unconditional delete_object that
    follows removes the only copy.
    """
    store = {"a.txt": b"precious"}
    _run(lambda acc: rename(acc, _spec("a.txt"), _spec("a.txt")), store,
         _config())
    assert store == {"a.txt": b"precious"}


def test_rename_onto_the_same_key_issues_no_writes():
    """POSIX rename(2): same existing file succeeds, no other action.

    Stronger than "the object survived": it must send nothing at all,
    since on AWS and MinIO the copy would come back InvalidRequest.
    """
    store = {"a.txt": b"precious"}
    session = MultiBucketSession({BUCKET: store})
    stack = patch_s3_session(session)
    try:
        asyncio.run(
            rename(S3Accessor(_config()), _spec("a.txt"), _spec("a.txt")))
        calls = session.client().calls
        assert calls["copy_object"] == 0
        assert calls["delete_object"] == 0
    finally:
        stack.close()


def test_copy_onto_the_same_key_is_a_no_op():
    store = {"a.txt": b"precious"}
    _run(lambda acc: copy(acc, _spec("a.txt"), _spec("a.txt")), store,
         _config())
    assert store == {"a.txt": b"precious"}


def test_rename_onto_the_same_key_still_fails_when_absent():
    """A missing source must not be silently reported as moved."""
    with pytest.raises(FileNotFoundError):
        _run(lambda acc: rename(acc, _spec("nope.txt"), _spec("nope.txt")), {},
             _config())


def test_copy_onto_the_same_key_still_fails_when_absent():
    with pytest.raises(FileNotFoundError):
        _run(lambda acc: copy(acc, _spec("nope.txt"), _spec("nope.txt")), {},
             _config())


def test_distinct_keys_still_move():
    """The guard must not swallow a real rename."""
    store = {"a.txt": b"precious"}
    _run(lambda acc: rename(acc, _spec("a.txt"), _spec("b.txt")), store,
         _config())
    assert store == {"b.txt": b"precious"}


def test_guard_compares_resolved_keys_not_spelling():
    """Two paths that differ only by the mount's key prefix are one key."""
    store = {"pre/a.txt": b"precious"}
    _run(lambda acc: rename(acc, _spec("a.txt"), _spec("a.txt")), store,
         _config(key_prefix="pre/"))
    assert store == {"pre/a.txt": b"precious"}

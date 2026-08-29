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

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.identity import live_identity
from mirage.resource.s3 import S3Config
from mirage.types import PathSpec
from tests.e2e.s3_mock import patch_s3_multi

BUCKET = "test-bucket"


def _config(key_prefix: str | None = None) -> S3Config:
    return S3Config(
        bucket=BUCKET,
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
        key_prefix=key_prefix,
    )


def _path(p: str) -> PathSpec:
    return PathSpec(virtual=p, directory=p, resource_path=p.strip("/"))


def test_identity_found_returns_etag_fingerprint_and_no_revision():
    store = {BUCKET: {"foo.txt": b"hello"}}
    with patch_s3_multi(store):
        accessor = S3Accessor(_config())
        result = asyncio.run(live_identity(accessor, _path("/foo.txt")))
    assert result.exists is True
    assert result.fingerprint is not None
    assert result.revision is None


def test_identity_versioned_bucket_returns_a_revision():
    store = {BUCKET: {"foo.txt": b"hello"}}
    with patch_s3_multi(store, versioned={BUCKET}):
        accessor = S3Accessor(_config())
        result = asyncio.run(live_identity(accessor, _path("/foo.txt")))
    assert result.exists is True
    assert result.fingerprint is not None
    assert result.revision is not None


def test_identity_missing_reports_exists_false():
    store = {BUCKET: {}}
    with patch_s3_multi(store):
        accessor = S3Accessor(_config())
        result = asyncio.run(live_identity(accessor, _path("/never.txt")))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


def test_identity_directory_raises_eisdir():
    store = {BUCKET: {"dir/f.txt": b"x"}}
    with patch_s3_multi(store):
        accessor = S3Accessor(_config())
        with pytest.raises(IsADirectoryError):
            asyncio.run(live_identity(accessor, _path("/dir")))


def test_identity_lifts_the_path_through_a_key_prefix():
    prefix = "users/abc/"
    store = {BUCKET: {"users/abc/a.txt": b"data"}}
    with patch_s3_multi(store):
        accessor = S3Accessor(_config(prefix))
        result = asyncio.run(live_identity(accessor, _path("/a.txt")))
    assert result.exists is True
    assert result.fingerprint is not None


def test_identity_missing_under_a_key_prefix():
    prefix = "users/abc/"
    store = {BUCKET: {"users/abc/a.txt": b"data"}}
    with patch_s3_multi(store):
        accessor = S3Accessor(_config(prefix))
        result = asyncio.run(live_identity(accessor, _path("/missing.txt")))
    assert result.exists is False

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

from typing import Any

import pytest
from botocore.exceptions import ClientError

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.copy import copy_from
from mirage.errors.classify import classify
from mirage.errors.types import FsCondition
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.s3 import S3Config

SRC = PathSpec(vfs_path="in/a.txt", virtual="/x/in/a.txt", directory="/x/in")
DST = PathSpec(
    vfs_path="out/a.txt", virtual="/y/out/a.txt", directory="/y/out"
)


class CopyClient:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.sent: list[dict[str, Any]] = []

    async def copy_object(self, **kwargs: Any) -> dict[str, Any]:
        self.sent.append(kwargs)
        if self.error is not None:
            raise self.error
        return {}


def _accessor(bucket: str, key: str = "fake", **extra: Any) -> S3Accessor:
    return S3Accessor(
        S3Config(
            bucket=bucket,
            region="us-east-1",
            aws_access_key_id=key,
            aws_secret_access_key="fake",
            **extra,
        )
    )


def _client(accessor: S3Accessor, client: CopyClient, monkeypatch) -> None:
    async def cached_client(factory: Any) -> CopyClient:
        return client

    monkeypatch.setattr(accessor, "cached_client", cached_client)


def _code(code: str, status: int) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        "CopyObject",
    )


@pytest.mark.asyncio
async def test_one_service_copies_across_buckets(monkeypatch):
    dst, src = _accessor("b2", key_prefix="p"), _accessor("b1")
    client = CopyClient()
    _client(dst, client, monkeypatch)
    scope = RecordingScope()
    try:
        await copy_from(dst, src, SRC, DST)
    finally:
        scope.close()
    assert [(r.op, r.path) for r in scope.records] == [("copy", DST.virtual)]
    assert client.sent == [
        {
            "Bucket": "b2",
            "Key": "p/out/a.txt",
            "CopySource": {"Bucket": "b1", "Key": "in/a.txt"},
        }
    ]


@pytest.mark.asyncio
async def test_other_credentials_ask_nothing(monkeypatch):
    dst, src = _accessor("b2"), _accessor("b1", key="other")
    client = CopyClient()
    _client(dst, client, monkeypatch)
    with pytest.raises(OSError) as info:
        await copy_from(dst, src, SRC, DST)
    assert classify(info.value) is FsCondition.EXDEV
    assert client.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error,condition",
    [
        (_code("AccessDenied", 403), FsCondition.EXDEV),
        (_code("NoSuchKey", 404), FsCondition.ENOENT),
    ],
)
async def test_a_refusal_moves_the_bytes_and_a_missing_source_is_missing(
    monkeypatch, error, condition
):
    dst, src = _accessor("b2"), _accessor("b1")
    _client(dst, CopyClient(error), monkeypatch)
    with pytest.raises(OSError) as info:
        await copy_from(dst, src, SRC, DST)
    assert classify(info.value) is condition

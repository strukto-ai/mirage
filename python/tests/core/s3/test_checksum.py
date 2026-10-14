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

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.checksum import checksum
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.s3 import S3Config

MD5 = "5d41402abc4b2a76b9719d911017c592"
SCOPE = PathSpec(vfs_path="foo.txt", virtual="/foo.txt", directory="/")


class HeadClient:
    def __init__(self, reply: dict[str, Any]) -> None:
        self.reply = reply
        self.asked: list[dict[str, Any]] = []

    async def head_object(self, **kwargs: Any) -> dict[str, Any]:
        self.asked.append(kwargs)
        return self.reply


def _accessor(
    client: HeadClient, monkeypatch: pytest.MonkeyPatch
) -> S3Accessor:
    accessor = S3Accessor(
        S3Config(
            bucket="b",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        )
    )

    async def cached_client(factory: Any) -> HeadClient:
        return client

    monkeypatch.setattr(accessor, "cached_client", cached_client)
    return accessor


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply,aws,expect",
    [
        ({"ETag": f'"{MD5}"'}, False, MD5),
        ({"ETag": f'"{MD5}"', "ServerSideEncryption": "AES256"}, True, MD5),
        ({"ETag": f'"{MD5}"', "ServerSideEncryption": "AES256"}, False, None),
        ({"ETag": f'"{MD5}"', "ServerSideEncryption": "aws:kms"}, True, None),
        ({"ETag": f'"{MD5}"', "SSECustomerAlgorithm": "AES256"}, True, None),
        ({"ETag": f'"{MD5}-3"'}, True, None),
        ({"ETag": '"0123"'}, True, None),
        ({}, True, None),
    ],
)
async def test_an_etag_is_the_md5_only_when_nothing_else_can_be(
    reply, aws, expect, monkeypatch
):
    client = HeadClient(reply)
    accessor = _accessor(client, monkeypatch)
    assert await checksum(accessor, SCOPE, "md5", aws) == expect
    assert client.asked == [{"Bucket": "b", "Key": "foo.txt"}]


@pytest.mark.asyncio
async def test_another_algorithm_asks_nothing(monkeypatch):
    client = HeadClient({"ETag": f'"{MD5}"'})
    accessor = _accessor(client, monkeypatch)
    assert await checksum(accessor, SCOPE, "sha256", True) is None
    assert client.asked == []


@pytest.mark.asyncio
async def test_an_answered_digest_records_the_version_it_saw(monkeypatch):
    client = HeadClient({"ETag": f'"{MD5}"', "VersionId": "v3"})
    accessor = _accessor(client, monkeypatch)
    scope = RecordingScope()
    try:
        assert await checksum(accessor, SCOPE, "md5", True) == MD5
    finally:
        scope.close()
    assert [
        (r.op, r.path, r.fingerprint, r.revision) for r in scope.records
    ] == [("read", "/foo.txt", MD5, "v3")]

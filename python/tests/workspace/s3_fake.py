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

import hashlib
from unittest.mock import patch

from botocore.exceptions import ClientError


class _Body:

    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self) -> bytes:
        return self._data


def _error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code}}, operation)


def etag_of(data: bytes) -> str:
    return '"' + hashlib.md5(data).hexdigest() + '"'


class _Paginator:

    def __init__(self, client: "FakeConditionalS3Client") -> None:
        self._client = client

    async def paginate(self, Bucket: str, Prefix: str = ""):
        contents = [{
            "Key": key,
            "Size": len(data)
        } for (bucket, key), data in sorted(self._client.objects.items())
                    if bucket == Bucket and key.startswith(Prefix)]
        yield {"Contents": contents}


class FakeConditionalS3Client:
    """In-memory S3 modeling exactly what the record stores rely on:
    content ETags on GET and conditional PUTs (If-Match, If-None-Match)."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}

    async def get_object(self, Bucket: str, Key: str) -> dict:
        data = self.objects.get((Bucket, Key))
        if data is None:
            raise _error("NoSuchKey", "GetObject")
        return {"Body": _Body(data), "ETag": etag_of(data)}

    async def put_object(self,
                         Bucket: str,
                         Key: str,
                         Body: bytes,
                         IfMatch: str | None = None,
                         IfNoneMatch: str | None = None) -> dict:
        current = self.objects.get((Bucket, Key))
        if IfNoneMatch == "*" and current is not None:
            raise _error("PreconditionFailed", "PutObject")
        if IfMatch is not None and (current is None
                                    or etag_of(current) != IfMatch):
            raise _error("PreconditionFailed", "PutObject")
        self.objects[(Bucket, Key)] = Body
        return {}

    async def delete_objects(self, Bucket: str, Delete: dict) -> dict:
        for entry in Delete["Objects"]:
            self.objects.pop((Bucket, entry["Key"]), None)
        return {}

    def get_paginator(self, name: str) -> _Paginator:
        assert name == "list_objects_v2"
        return _Paginator(self)


class _ClientContext:

    def __init__(self, client: FakeConditionalS3Client) -> None:
        self._client = client

    async def __aenter__(self) -> FakeConditionalS3Client:
        return self._client

    async def __aexit__(self, *exc: object) -> None:
        return None


class FakeSession:

    def __init__(self, client: FakeConditionalS3Client) -> None:
        self._client = client

    def client(self, **kwargs: object) -> _ClientContext:
        return _ClientContext(self._client)


def patch_record_s3(client: FakeConditionalS3Client):
    """Patch the record stores' session factory to serve ``client``."""
    session = FakeSession(client)
    return patch("mirage.workspace.session.s3.async_session",
                 lambda config: session)

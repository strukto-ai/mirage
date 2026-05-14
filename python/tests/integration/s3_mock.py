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
from contextlib import ExitStack
from datetime import datetime, timezone
from unittest.mock import patch

LAST_MODIFIED = datetime(2026, 3, 31, tzinfo=timezone.utc)

_CORE_MODULES = [
    "mirage.core.s3.read",
    "mirage.core.s3.write",
    "mirage.core.s3.stat",
    "mirage.core.s3.readdir",
    "mirage.core.s3.find",
    "mirage.core.s3.du",
    "mirage.core.s3.stream",
    "mirage.core.s3.copy",
    "mirage.core.s3.rename",
    "mirage.core.s3.unlink",
    "mirage.core.s3.rmdir",
    "mirage.core.s3.rm",
    "mirage.core.s3.mkdir",
    "mirage.core.s3.create",
    "mirage.core.s3.truncate",
]


class _AsyncMockBody:

    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self) -> bytes:
        return self._data

    async def iter_chunks(self, chunk_size: int = 8192):
        for i in range(0, len(self._data), chunk_size):
            yield self._data[i:i + chunk_size]


def _mock_s3_error(code: str) -> Exception:
    exc = Exception(code)
    exc.response = {"Error": {"Code": code}}
    return exc


def _paginate_directory(objects, prefix):
    common_prefixes: set[str] = set()
    contents: list[dict[str, object]] = []
    for key, data in sorted(objects.items()):
        if not key.startswith(prefix):
            continue
        relative = key[len(prefix):]
        if not relative:
            contents.append({"Key": key, "Size": len(data)})
            continue
        if "/" in relative:
            child = relative.split("/", 1)[0]
            common_prefixes.add(prefix + child + "/")
            continue
        contents.append({"Key": key, "Size": len(data)})
    return {
        "CommonPrefixes": [{
            "Prefix": v
        } for v in sorted(common_prefixes)],
        "Contents": contents,
    }


def _paginate_flat(objects, prefix):
    return {
        "Contents": [{
            "Key": k,
            "Size": len(v)
        } for k, v in sorted(objects.items()) if k.startswith(prefix)]
    }


def _slice_range(data: bytes, range_spec: str) -> bytes:
    if not range_spec.startswith("bytes="):
        return data
    bounds = range_spec.removeprefix("bytes=").split("-", 1)
    start = int(bounds[0]) if bounds[0] else 0
    end = int(bounds[1]) if bounds[1] else len(data) - 1
    return data[start:end + 1]


class _MultiBucketPaginator:

    def __init__(self, buckets: dict[str, dict[str, bytes]]) -> None:
        self.buckets = buckets

    async def paginate(self,
                       Bucket: str,
                       Prefix: str = "",
                       Delimiter: str | None = None):
        objects = self.buckets.get(Bucket, {})
        if Delimiter == "/":
            yield _paginate_directory(objects, Prefix)
        else:
            yield _paginate_flat(objects, Prefix)


class MultiBucketS3Client:

    def __init__(self,
                 buckets: dict[str, dict[str, bytes]],
                 versioned: set[str] | None = None) -> None:
        self.buckets = buckets
        self.versioned = versioned or set()
        self._versions: dict[tuple[str, str], list[tuple[str, bytes]]] = {}

    def _objects(self, bucket: str) -> dict[str, bytes]:
        if bucket not in self.buckets:
            self.buckets[bucket] = {}
        return self.buckets[bucket]

    def _track(self, bucket: str, key: str) -> str | None:
        if bucket not in self.versioned:
            return None
        current = self.buckets.get(bucket, {}).get(key)
        if current is None:
            return None
        history = self._versions.setdefault((bucket, key), [])
        if not history or history[-1][1] != current:
            vid = f"v{len(history) + 1}-{hashlib.md5(current).hexdigest()[:8]}"
            history.append((vid, current))
        return history[-1][0]

    async def get_object(self,
                         Bucket: str,
                         Key: str,
                         Range: str | None = None,
                         VersionId: str | None = None) -> dict:
        vid_for_resp = self._track(Bucket, Key)
        if VersionId is not None:
            history = self._versions.get((Bucket, Key), [])
            for vid, data in history:
                if vid == VersionId:
                    vid_for_resp = vid
                    break
            else:
                raise _mock_s3_error("NoSuchVersion")
        else:
            objects = self._objects(Bucket)
            if Key not in objects:
                raise _mock_s3_error("NoSuchKey")
            data = objects[Key]
        etag = hashlib.md5(data).hexdigest()
        if Range is not None:
            data = _slice_range(data, Range)
        resp: dict = {"Body": _AsyncMockBody(data), "ETag": f'"{etag}"'}
        if vid_for_resp is not None:
            resp["VersionId"] = vid_for_resp
        return resp

    async def head_object(self, Bucket: str, Key: str) -> dict:
        objects = self._objects(Bucket)
        if Key not in objects:
            raise _mock_s3_error("NoSuchKey")
        data = objects[Key]
        etag = hashlib.md5(data).hexdigest()
        vid = self._track(Bucket, Key)
        resp: dict = {
            "ContentLength": len(data),
            "LastModified": LAST_MODIFIED,
            "ETag": f'"{etag}"',
        }
        if vid is not None:
            resp["VersionId"] = vid
        return resp

    def get_paginator(self, name: str):
        assert name == "list_objects_v2"
        return _MultiBucketPaginator(self.buckets)

    async def put_object(self, Bucket: str, Key: str, Body: bytes) -> None:
        self._objects(Bucket)[Key] = Body

    async def delete_object(self, Bucket: str, Key: str) -> None:
        self._objects(Bucket).pop(Key, None)

    async def copy_object(self, Bucket: str, CopySource: dict,
                          Key: str) -> None:
        src_bucket = CopySource.get("Bucket", Bucket)
        src_key = CopySource["Key"]
        src_objects = self._objects(src_bucket)
        if src_key in src_objects:
            self._objects(Bucket)[Key] = src_objects[src_key]

    async def delete_objects(self, Bucket: str, Delete: dict) -> None:
        objects = self._objects(Bucket)
        for obj in Delete.get("Objects", []):
            objects.pop(obj["Key"], None)

    async def list_objects_v2(self,
                              Bucket: str,
                              Prefix: str = "",
                              Delimiter: str = "",
                              MaxKeys: int = 1000,
                              **kwargs) -> dict:
        del MaxKeys, kwargs
        objects = self._objects(Bucket)
        if Delimiter == "/":
            return _paginate_directory(objects, Prefix)
        return _paginate_flat(objects, Prefix)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class MultiBucketSession:

    def __init__(self,
                 buckets: dict[str, dict[str, bytes]],
                 versioned: set[str] | None = None) -> None:
        self._client = MultiBucketS3Client(buckets, versioned=versioned)

    def client(self, **kwargs):
        return self._client


def patch_s3_multi(buckets: dict[str, dict[str, bytes]],
                   versioned: set[str] | None = None) -> ExitStack:
    session = MultiBucketSession(buckets, versioned=versioned)
    stack = ExitStack()
    for mod in _CORE_MODULES:
        stack.enter_context(patch(f"{mod}.async_session",
                                  return_value=session))
    return stack

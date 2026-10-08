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
from collections import Counter
from collections.abc import Awaitable, Callable
from contextlib import ExitStack
from datetime import datetime, timezone
from unittest.mock import patch

LAST_MODIFIED = datetime(2026, 3, 31, tzinfo=timezone.utc)

# Every kit-derived op reaches the store through the driver's single
# connect seam; read, stream, and watch keep a native session of their
# own.
_CORE_MODULES = [
    "mirage.core.s3.driver",
    "mirage.core.s3.read",
    "mirage.core.s3.stream",
    "mirage.core.s3.watch",
]


class _AsyncMockBody:
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self) -> bytes:
        return self._data

    async def iter_chunks(self, chunk_size: int = 8192):
        for i in range(0, len(self._data), chunk_size):
            yield self._data[i : i + chunk_size]


def _mock_s3_error(code: str, status: int | None = None) -> Exception:
    exc = Exception(code)
    exc.response = {"Error": {"Code": code}}
    if status is not None:
        exc.response["ResponseMetadata"] = {"HTTPStatusCode": status}
    return exc


def _bare(etag: str) -> str:
    return etag.strip('"')


def _sent(kwargs: dict[str, str]) -> dict[str, str]:
    return {k: kwargs[k] for k in _CONDITION_KEYS if k in kwargs}


_CONDITION_KEYS = ("IfMatch", "IfNoneMatch", "CopySourceIfMatch")

MUTATIONS = ("put_object", "copy_object", "delete_object", "delete_objects")


def _content_entry(key: str, data: bytes) -> dict[str, object]:
    """One Contents row, shaped like the real list_objects_v2.

    Real S3 carries an ETag on every listed object, which is what the
    watch walk fingerprints on, so the mock has to carry one too.

    Args:
        key (str): Object key.
        data (bytes): Object content.
    """
    return {
        "Key": key,
        "Size": len(data),
        "LastModified": LAST_MODIFIED,
        "ETag": f'"{hashlib.md5(data).hexdigest()}"',
    }


def _paginate_directory(objects, prefix):
    common_prefixes: set[str] = set()
    contents: list[dict[str, object]] = []
    for key, data in sorted(objects.items()):
        if not key.startswith(prefix):
            continue
        relative = key[len(prefix) :]
        if not relative:
            contents.append(_content_entry(key, data))
            continue
        if "/" in relative:
            child = relative.split("/", 1)[0]
            common_prefixes.add(prefix + child + "/")
            continue
        contents.append(_content_entry(key, data))
    return {
        "CommonPrefixes": [{"Prefix": v} for v in sorted(common_prefixes)],
        "Contents": contents,
    }


def _paginate_flat(objects, prefix):
    return {
        "Contents": [
            _content_entry(k, v)
            for k, v in sorted(objects.items())
            if k.startswith(prefix)
        ]
    }


def _slice_range(data: bytes, range_spec: str) -> bytes:
    if not range_spec.startswith("bytes="):
        return data
    bounds = range_spec.removeprefix("bytes=").split("-", 1)
    start = int(bounds[0]) if bounds[0] else 0
    end = int(bounds[1]) if bounds[1] else len(data) - 1
    return data[start : end + 1]


class _MultiBucketPaginator:
    def __init__(
        self,
        buckets: dict[str, dict[str, bytes]],
        bucket_calls: Counter[tuple[str, str]],
        page_size: int | None = None,
    ) -> None:
        self.buckets = buckets
        self.bucket_calls = bucket_calls
        self.page_size = page_size

    async def paginate(
        self, Bucket: str, Prefix: str = "", Delimiter: str | None = None
    ):
        self.bucket_calls["list_objects_v2", Bucket] += 1
        objects = self.buckets.get(Bucket, {})
        if Delimiter == "/":
            yield _paginate_directory(objects, Prefix)
            return
        page = _paginate_flat(objects, Prefix)
        rows = page.get("Contents") or []
        if self.page_size is None or len(rows) <= self.page_size:
            yield page
            return
        for start in range(0, len(rows), self.page_size):
            yield {"Contents": rows[start : start + self.page_size]}


class MultiBucketS3Client:
    def __init__(
        self,
        buckets: dict[str, dict[str, bytes]],
        versioned: set[str] | None = None,
        etag_suffix: str = "",
    ) -> None:
        self.buckets = buckets
        self.versioned = versioned or set()
        self._versions: dict[tuple[str, str], list[tuple[str, bytes]]] = {}
        # Non-empty simulates multipart-upload ETags ("<md5>-2"), which are
        # NOT the MD5 of the content.
        self.etag_suffix = etag_suffix
        self.calls: Counter[str] = Counter()
        # Per (method, bucket): every request, listings included.
        self.bucket_calls: Counter[tuple[str, str]] = Counter()
        # Keys DeleteObjects refuses, reported under "Errors" in a 200.
        self.undeletable: set[str] = set()
        # Rows per list_objects_v2 page; None answers in one page.
        self.page_size: int | None = None
        # Every request in order, with the condition parameters it sent:
        # what a conditional-write test reads to learn which version went
        # out, rather than a count that HEAD+PUT would also satisfy.
        self.ledger: list[tuple[str, dict[str, str]]] = []
        self._hooks: dict[str, list[Callable[[], Awaitable[None] | None]]] = {}
        # Raise on a mutation that carries no condition: every write on a
        # conditional mount must carry one, so a route that bypasses the
        # policy fails here instead of passing silently. A marker key
        # (trailing slash) is exempt, because rmdir is unconditional.
        self.tripwire = False

    def before(
        self, op: str, hook: Callable[[], Awaitable[None] | None]
    ) -> None:
        """Run ``hook`` once, just before the next ``op`` request lands.

        This is how a test puts another writer between an op's own read
        and its write.

        Args:
            op (str): request name, e.g. ``"put_object"``.
            hook (Callable): mutation of the store; may be async.
        """
        self._hooks.setdefault(op, []).append(hook)

    async def _enter(self, op: str, key: str, sent: dict[str, str]) -> None:
        self.ledger.append((op, sent))
        hooks = self._hooks.get(op)
        if hooks:
            result = hooks.pop(0)()
            if result is not None:
                await result
        if (
            self.tripwire
            and op in MUTATIONS
            and not sent
            and not key.endswith("/")
        ):
            raise AssertionError(f"unconditioned {op} of {key!r}")

    def _require(
        self,
        current: bytes | None,
        if_match: str | None,
        if_none_match: str | None,
    ) -> None:
        # Quotes are stripped on both sides so the fake accepts either
        # spelling; which one the driver sends is the driver's contract,
        # tested there, not a guess the fake should pin.
        if if_none_match == "*" and current is not None:
            raise _mock_s3_error("PreconditionFailed", 412)
        # AWS answers an If-Match on a key that is gone with 404, not 412
        # (user guide, "Conditional write behavior").
        if if_match is not None and current is None:
            raise _mock_s3_error("NoSuchKey")
        if if_match is not None and _bare(if_match) != _bare(
            self._etag(current)
        ):
            raise _mock_s3_error("PreconditionFailed", 412)

    def _etag(self, data: bytes) -> str:
        return hashlib.md5(data).hexdigest() + self.etag_suffix

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

    async def get_object(
        self,
        Bucket: str,
        Key: str,
        Range: str | None = None,
        VersionId: str | None = None,
    ) -> dict:
        self.calls["get_object"] += 1
        self.bucket_calls["get_object", Bucket] += 1
        await self._enter("get_object", Key, {})
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
        etag = self._etag(data)
        if Range is not None:
            data = _slice_range(data, Range)
        resp: dict = {"Body": _AsyncMockBody(data), "ETag": f'"{etag}"'}
        if vid_for_resp is not None:
            resp["VersionId"] = vid_for_resp
        return resp

    async def head_object(self, Bucket: str, Key: str) -> dict:
        self.calls["head_object"] += 1
        self.bucket_calls["head_object", Bucket] += 1
        await self._enter("head_object", Key, {})
        objects = self._objects(Bucket)
        if Key not in objects:
            raise _mock_s3_error("NoSuchKey")
        data = objects[Key]
        etag = self._etag(data)
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
        return _MultiBucketPaginator(
            self.buckets, self.bucket_calls, self.page_size
        )

    async def put_object(
        self, Bucket: str, Key: str, Body: bytes, **kwargs: str
    ) -> dict:
        self.calls["put_object"] += 1
        self.bucket_calls["put_object", Bucket] += 1
        await self._enter("put_object", Key, _sent(kwargs))
        self._require(
            self._objects(Bucket).get(Key),
            kwargs.get("IfMatch"),
            kwargs.get("IfNoneMatch"),
        )
        self._objects(Bucket)[Key] = Body
        # Real PutObject answers the stored object's ETag, so the token a
        # write stamps is the one head_object reports next -- suffix
        # included, which is what makes a multipart-shaped ETag testable.
        resp: dict = {"ETag": f'"{self._etag(Body)}"'}
        vid = self._track(Bucket, Key)
        if vid is not None:
            resp["VersionId"] = vid
        return resp

    async def delete_object(
        self, Bucket: str, Key: str, **kwargs: str
    ) -> None:
        self.calls["delete_object"] += 1
        self.bucket_calls["delete_object", Bucket] += 1
        await self._enter("delete_object", Key, _sent(kwargs))
        current = self._objects(Bucket).get(Key)
        if current is not None:
            self._require(current, kwargs.get("IfMatch"), None)
        self._objects(Bucket).pop(Key, None)

    async def copy_object(
        self, Bucket: str, CopySource: dict, Key: str, **kwargs: str
    ) -> dict:
        # Deliberately lenient: a self-copy is accepted, the way a
        # non-AWS S3-compatible store might. That is what makes the
        # same-key guard observable in tests (#150).
        self.calls["copy_object"] += 1
        self.bucket_calls["copy_object", Bucket] += 1
        await self._enter("copy_object", Key, _sent(kwargs))
        src_bucket = CopySource.get("Bucket", Bucket)
        src_key = CopySource["Key"]
        src_objects = self._objects(src_bucket)
        if src_key not in src_objects:
            return {}
        source_match = kwargs.get("CopySourceIfMatch")
        if source_match is not None and _bare(source_match) != _bare(
            self._etag(src_objects[src_key])
        ):
            raise _mock_s3_error("PreconditionFailed", 412)
        self._require(
            self._objects(Bucket).get(Key),
            kwargs.get("IfMatch"),
            kwargs.get("IfNoneMatch"),
        )
        data = src_objects[src_key]
        self._objects(Bucket)[Key] = data
        return {"CopyObjectResult": {"ETag": f'"{self._etag(data)}"'}}

    async def delete_objects(self, Bucket: str, Delete: dict) -> dict:
        # Real DeleteObjects answers 200 with per-key results, and reports a
        # key it refused under "Errors" rather than raising. `undeletable`
        # is how a test asks for that half.
        self.calls["delete_objects"] += 1
        self.bucket_calls["delete_objects", Bucket] += 1
        listed = Delete.get("Objects", [])
        # Judged per key: a marker is exempt, but an untagged file key in
        # the same batch still trips, whichever key comes first.
        bare = [
            o["Key"]
            for o in listed
            if "ETag" not in o and not o["Key"].endswith("/")
        ]
        tags = [str(o["ETag"]) for o in listed if "ETag" in o]
        tagged = {"ETag": ",".join(tags)} if tags and not bare else {}
        first = bare[0] if bare else (listed[0]["Key"] if listed else "")
        await self._enter("delete_objects", first, tagged)
        objects = self._objects(Bucket)
        deleted: list[dict] = []
        errors: list[dict] = []
        for obj in listed:
            key = obj["Key"]
            expected = obj.get("ETag")
            current = objects.get(key)
            if (
                expected is not None
                and current is not None
                and _bare(str(expected)) != _bare(self._etag(current))
            ):
                errors.append(
                    {
                        "Key": key,
                        "Code": "PreconditionFailed",
                        "Message": "At least one of the pre-conditions "
                        "you specified did not hold",
                    }
                )
                continue
            if key in self.undeletable:
                errors.append(
                    {
                        "Key": key,
                        "Code": "AccessDenied",
                        "Message": "Access Denied",
                    }
                )
                continue
            objects.pop(key, None)
            deleted.append({"Key": key})
        return {"Deleted": deleted, "Errors": errors}

    async def list_objects_v2(
        self,
        Bucket: str,
        Prefix: str = "",
        Delimiter: str = "",
        MaxKeys: int = 1000,
        **kwargs,
    ) -> dict:
        del MaxKeys, kwargs
        self.bucket_calls["list_objects_v2", Bucket] += 1
        objects = self._objects(Bucket)
        if Delimiter == "/":
            return _paginate_directory(objects, Prefix)
        return _paginate_flat(objects, Prefix)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class MultiBucketSession:
    def __init__(
        self,
        buckets: dict[str, dict[str, bytes]],
        versioned: set[str] | None = None,
        etag_suffix: str = "",
    ) -> None:
        self._client = MultiBucketS3Client(
            buckets, versioned=versioned, etag_suffix=etag_suffix
        )

    def client(self, **kwargs):
        return self._client


def patch_s3_session(session: MultiBucketSession) -> ExitStack:
    stack = ExitStack()
    for mod in _CORE_MODULES:
        stack.enter_context(
            patch(f"{mod}.async_session", return_value=session)
        )
    return stack


def patch_s3_multi(
    buckets: dict[str, dict[str, bytes]], versioned: set[str] | None = None
) -> ExitStack:
    return patch_s3_session(MultiBucketSession(buckets, versioned=versioned))

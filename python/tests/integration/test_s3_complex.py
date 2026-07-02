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

from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from mirage.commands.builtin.s3 import COMMANDS as _S3_COMMANDS
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import MountMode, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace import Workspace

DATA_DIR = Path(__file__).resolve().parents[3] / "data"

s3_cat = next(fn for fn in _S3_COMMANDS for rc in fn._registered_commands
              if rc.name == "cat" and rc.filetype is None)
LAST_MODIFIED = datetime(2026, 3, 26, tzinfo=timezone.utc)

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


class MockS3Error(Exception):

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class AsyncMockBody:

    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self) -> bytes:
        return self._data

    async def iter_chunks(self, chunk_size: int = 8192):
        for i in range(0, len(self._data), chunk_size):
            yield self._data[i:i + chunk_size]


class AsyncMockPaginator:

    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    async def paginate(self,
                       Bucket: str,
                       Prefix: str = "",
                       Delimiter: str | None = None):
        del Bucket
        if Delimiter == "/":
            yield _paginate_directory(self.objects, Prefix)
        else:
            yield _paginate_flat(self.objects, Prefix)


class AsyncMockS3Client:

    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    async def get_object(self,
                         Bucket: str,
                         Key: str,
                         Range: str | None = None) -> dict:
        del Bucket
        if Key not in self.objects:
            raise MockS3Error("NoSuchKey")
        data = self.objects[Key]
        if Range is not None:
            data = _slice_range(data, Range)
        return {"Body": AsyncMockBody(data)}

    async def head_object(self, Bucket: str, Key: str) -> dict:
        del Bucket
        if Key not in self.objects:
            raise MockS3Error("NoSuchKey")
        return {
            "ContentLength": len(self.objects[Key]),
            "LastModified": LAST_MODIFIED,
            "ETag": f'"{Key}"',
        }

    def get_paginator(self, name: str) -> AsyncMockPaginator:
        assert name == "list_objects_v2"
        return AsyncMockPaginator(self.objects)

    async def put_object(self, Bucket: str, Key: str, Body: bytes) -> None:
        self.objects[Key] = Body

    async def delete_object(self, Bucket: str, Key: str) -> None:
        self.objects.pop(Key, None)

    async def copy_object(self, Bucket: str, CopySource: dict,
                          Key: str) -> None:
        src_key = CopySource["Key"]
        if src_key in self.objects:
            self.objects[Key] = self.objects[src_key]

    async def delete_objects(self, Bucket: str, Delete: dict) -> None:
        for obj in Delete.get("Objects", []):
            self.objects.pop(obj["Key"], None)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class MockAsyncSession:

    def __init__(self, objects: dict[str, bytes]) -> None:
        self._client = AsyncMockS3Client(objects)

    def client(self, **kwargs):
        return self._client


def _paginate_directory(objects, prefix):
    common_prefixes: set[str] = set()
    contents: list[dict[str, object]] = []
    for key, data in sorted(objects.items()):
        if not key.startswith(prefix):
            continue
        relative = key[len(prefix):]
        if not relative:
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


def _load_example_jsonl(limit: int = 20) -> bytes:
    chunks: list[bytes] = []
    with (DATA_DIR / "example.jsonl").open("rb") as handle:
        for _ in range(limit):
            line = handle.readline()
            if not line:
                break
            chunks.append(line)
    return b"".join(chunks)


def _s3_objects() -> dict[str, bytes]:
    return {
        "data/example.json": (DATA_DIR / "example.json").read_bytes(),
        "data/example.jsonl": _load_example_jsonl(),
        "reports/summary.txt": b"alpha report\nbeta report\n",
        "archive/2026/q1/deep.txt": b"deep archive\n",
    }


def _s3_backend() -> S3Resource:
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    return S3Resource(config)


def _patch_async_session(objects):
    mock_session = MockAsyncSession(objects)
    stack = ExitStack()
    for mod in _CORE_MODULES:
        stack.enter_context(
            patch(f"{mod}.async_session", return_value=mock_session))
    return stack


@pytest.fixture
def ws():
    objects = _s3_objects()
    with _patch_async_session(objects):
        yield Workspace(
            {
                "/s3/": (_s3_backend(), MountMode.READ),
                "/tmp/": (RAMResource(), MountMode.WRITE),
            },
            mode=MountMode.WRITE,
        )


@pytest.mark.asyncio
async def test_find_sort_lists_expected_s3_files(ws):
    objects = _s3_objects()
    with _patch_async_session(objects):
        io = await ws.execute("find /s3 -maxdepth 2 -type f | sort")
        assert (await io.stdout_str()).strip().splitlines() == [
            "/s3/data/example.json",
            "/s3/data/example.jsonl",
            "/s3/reports/summary.txt",
        ]


@pytest.mark.asyncio
async def test_file_report_through_redirect_chain(ws):
    objects = _s3_objects()
    with _patch_async_session(objects):
        io = await ws.execute(
            "echo '=== /s3/data/example.json ===' > /tmp/file_report.txt && "
            "file /s3/data/example.json >> /tmp/file_report.txt && "
            "echo >> /tmp/file_report.txt && "
            "echo '=== /s3/data/example.jsonl ===' >> /tmp/file_report.txt && "
            "file /s3/data/example.jsonl >> /tmp/file_report.txt && "
            "echo >> /tmp/file_report.txt && "
            "echo '=== /s3/reports/summary.txt ===' "
            ">> /tmp/file_report.txt && "
            "file /s3/reports/summary.txt >> /tmp/file_report.txt && "
            "echo >> /tmp/file_report.txt && "
            "cat /tmp/file_report.txt")
        assert (await io.stdout_str()).strip().splitlines() == [
            "=== /s3/data/example.json ===",
            "/s3/data/example.json: json",
            "",
            "=== /s3/data/example.jsonl ===",
            "/s3/data/example.jsonl: json",
            "",
            "=== /s3/reports/summary.txt ===",
            "/s3/reports/summary.txt: text",
        ]


@pytest.mark.asyncio
async def test_wc_report_through_redirect_chain(ws):
    objects = _s3_objects()
    with _patch_async_session(objects):
        io = await ws.execute(
            "echo -n '/s3/data/example.json ' > /tmp/size_report.txt && "
            "wc -c /s3/data/example.json >> /tmp/size_report.txt && "
            "echo -n '/s3/data/example.jsonl ' >> /tmp/size_report.txt && "
            "wc -c /s3/data/example.jsonl >> /tmp/size_report.txt && "
            "cat /tmp/size_report.txt")
        json_size = len(objects["data/example.json"])
        jsonl_size = len(objects["data/example.jsonl"])
        assert (await io.stdout_str()).strip().splitlines() == [
            f"/s3/data/example.json {json_size} /s3/data/example.json",
            f"/s3/data/example.jsonl {jsonl_size} /s3/data/example.jsonl",
        ]


@pytest.mark.asyncio
async def test_grep_then_jq_with_and_or_list(ws):
    objects = _s3_objects()
    with _patch_async_session(objects):
        io = await ws.execute(
            "grep -l mirage /s3/data/example.jsonl "
            "> /tmp/search_report.txt && "
            "echo >> /tmp/search_report.txt && "
            "jq .company /s3/data/example.json >> /tmp/search_report.txt || "
            "echo missing > /tmp/search_report.txt; "
            "cat /tmp/search_report.txt")
        assert (await io.stdout_str()).strip().splitlines() == [
            "/s3/data/example.jsonl",
            "",
            '"Strukto"',
        ]


def _resolved(original: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(original, "/s3"),
                    virtual=original,
                    directory=original,
                    resolved=True)


@pytest.mark.asyncio
async def test_cat_multifile_caches_materialized_bytes_per_file():
    """Regression: multi-file cat on a streaming backend must register fully
    materialized bytes per path in io.reads (not un-exhausted cachables). A
    per-file cachable cannot preserve stdout identity, so the cache-fill
    background drain raced the consumer on the same network stream and
    poisoned each file's cache slot. Materialized bytes cache deterministically
    with no drain and no race."""
    objects = _s3_objects()
    backend = _s3_backend()
    with _patch_async_session(objects):
        a = _resolved("/s3/reports/summary.txt")
        b = _resolved("/s3/archive/2026/q1/deep.txt")
        source, io = await s3_cat(backend.accessor, [a, b], index=None)

        assert io.reads[
            "/reports/summary.txt"] == b"alpha report\nbeta report\n"
        assert io.reads["/archive/2026/q1/deep.txt"] == b"deep archive\n"
        assert all(isinstance(v, bytes) for v in io.reads.values())

        combined = b"".join([chunk async for chunk in source])
        assert combined == b"alpha report\nbeta report\ndeep archive\n"


@pytest.mark.asyncio
async def test_cat_single_file_keeps_streaming_cachable():
    """The single-file path must stay a streaming cachable returned AS stdout
    (identity preserved) so large files still stream, not materialize."""
    objects = _s3_objects()
    backend = _s3_backend()
    with _patch_async_session(objects):
        a = _resolved("/s3/reports/summary.txt")
        source, io = await s3_cat(backend.accessor, [a], index=None)
        assert isinstance(source, CachableAsyncIterator)
        assert io.reads["/reports/summary.txt"] is source

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
import os
import subprocess
import uuid
from collections.abc import AsyncIterator
from contextlib import ExitStack
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.write import write_bytes as mem_write
from mirage.io.types import ByteSource
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace

BUCKET = "test-bucket"
REGION = "us-east-1"
# A current timestamp: -mtime -N filters are now honored by the s3 core,
# so a fixed past date would wrongly exclude freshly "written" objects.
LAST_MODIFIED = datetime.now(timezone.utc)

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
            raise _mock_s3_error("NoSuchKey")
        data = self.objects[Key]
        if Range is not None:
            data = _slice_range(data, Range)
        return {"Body": AsyncMockBody(data)}

    async def head_object(self, Bucket: str, Key: str) -> dict:
        del Bucket
        if Key not in self.objects:
            raise _mock_s3_error("NoSuchKey")
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

    async def list_objects_v2(self,
                              Bucket: str,
                              Prefix: str = "",
                              Delimiter: str = "",
                              MaxKeys: int = 1000,
                              **kwargs) -> dict:
        if Delimiter == "/":
            return _paginate_directory(self.objects, Prefix)
        return _paginate_flat(self.objects, Prefix)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class MockAsyncSession:

    def __init__(self, objects: dict[str, bytes]) -> None:
        self._client = AsyncMockS3Client(objects)

    def client(self, **kwargs):
        return self._client


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


def _patch_async_session(objects):
    mock_session = MockAsyncSession(objects)
    stack = ExitStack()
    for mod in _CORE_MODULES:
        stack.enter_context(
            patch(f"{mod}.async_session", return_value=mock_session))
    return stack


def _make_s3_env(tmp_path):
    objects: dict[str, bytes] = {}
    config = S3Config(
        bucket=BUCKET,
        region=REGION,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )
    resource = S3Resource(config)
    return NativeTestEnv(tmp_path, resource, "s3", objects=objects)


def _make_memory_env(tmp_path):
    resource = RAMResource()
    return NativeTestEnv(tmp_path, resource, "ram")


def _make_disk_env(tmp_path):
    disk_root = tmp_path / "disk_root"
    disk_root.mkdir()
    resource = DiskResource(root=str(disk_root))
    return NativeTestEnv(tmp_path, resource, "disk", disk_root=disk_root)


def _make_redis_env(tmp_path):
    url = os.environ["REDIS_URL"]
    prefix = f"mirage:test:{uuid.uuid4().hex[:8]}:"
    resource = RedisResource(url=url, key_prefix=prefix)
    return NativeTestEnv(tmp_path, resource, "redis")


def _redis_available():
    return "REDIS_URL" in os.environ


_PARAMS = ["ram", "s3", "disk"]
if _redis_available():
    _PARAMS.append("redis")


@pytest.fixture(params=_PARAMS)
def env(request, tmp_path):
    if request.param == "s3":
        test_env = _make_s3_env(tmp_path)
        with _patch_async_session(test_env.objects):
            yield test_env
    elif request.param == "disk":
        yield _make_disk_env(tmp_path)
    elif request.param == "redis":
        test_env = _make_redis_env(tmp_path)
        yield test_env
        asyncio.run(test_env.resource._store.clear())
    else:
        yield _make_memory_env(tmp_path)


async def _drain(ait: AsyncIterator[bytes]) -> list[bytes]:
    return [chunk async for chunk in ait]


def _collect(stdout: ByteSource | None) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_drain(stdout)))


class NativeTestEnv:

    def __init__(self,
                 tmp_path,
                 resource,
                 resource_type,
                 objects=None,
                 disk_root=None):
        self.tmp_path = tmp_path
        self.resource = resource
        self.resource_type = resource_type
        self.objects = objects
        self.disk_root = disk_root
        self.ws = Workspace(
            {"/data": (resource, MountMode.WRITE)},
            mode=MountMode.WRITE,
        )

    def create_file(self, name: str, content: bytes):
        local_path = self.tmp_path / name
        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(content)
        remote_path = "/" + name
        if self.resource_type == "disk":
            resource_path = self.disk_root / name
            resource_path.parent.mkdir(parents=True, exist_ok=True)
            resource_path.write_bytes(content)
        elif self.resource_type == "s3":
            key = name
            self.objects[key] = content
        elif self.resource_type == "redis":
            self._redis_write(remote_path, content)
        else:
            self._memory_write(remote_path, content)

    def _redis_write(self, path: str, content: bytes):
        store = self.resource._store
        parts = path.strip("/").split("/")
        for i in range(1, len(parts)):
            d = "/" + "/".join(parts[:i])
            asyncio.run(store.add_dir(d))
        asyncio.run(store.set_file(path, content))

    def _memory_write(self, path: str, content: bytes):
        accessor = self.resource.accessor
        parts = path.strip("/").split("/")
        for i in range(1, len(parts)):
            d = "/" + "/".join(parts[:i])
            if d not in accessor.store.dirs:
                try:
                    asyncio.run(mkdir(accessor, PathSpec.from_str_path(d)))
                except (FileExistsError, ValueError):
                    pass
        asyncio.run(mem_write(accessor, PathSpec.from_str_path(path), content))

    def native(self, cmd: str, stdin: bytes | None = None) -> str:
        native_cwd = self.disk_root if self.disk_root else self.tmp_path
        result = subprocess.run(
            ["/bin/sh", "-c", cmd],
            cwd=str(native_cwd),
            capture_output=True,
            input=stdin,
        )
        return result.stdout.decode(errors="replace")

    def mirage(self, cmd: str, stdin: bytes | None = None) -> str:
        self.ws._cwd = "/data"
        io = asyncio.run(self.ws.execute(cmd, stdin=stdin))
        if io.exit_code:
            import sys
            err = _collect(io.stderr).decode(errors="replace")
            print(
                f"\nMIRAGE-DEBUG exit={io.exit_code} cmd={cmd!r} "
                f"stderr={err!r}",
                file=sys.stderr)
        return _collect(io.stdout).decode(errors="replace")

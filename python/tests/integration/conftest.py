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
from datetime import datetime, timezone
from unittest.mock import patch

from mirage.core.ram.mkdir import mkdir as mem_mkdir
from mirage.core.ram.write import write_bytes as mem_write
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import MountMode
from mirage.workspace import Workspace

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
        return {"Body": AsyncMockBody(data), "ETag": f'"{Key}"'}

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


def patch_async_session(objects):
    mock_session = MockAsyncSession(objects)
    stack = ExitStack()
    for mod in _CORE_MODULES:
        stack.enter_context(
            patch(f"{mod}.async_session", return_value=mock_session))
    return stack


def make_s3_ws(objects: dict[str, bytes]) -> Workspace:
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    resource = S3Resource(config)
    return Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def make_memory_ws() -> tuple[Workspace, RAMResource]:
    resource = RAMResource()
    ws = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, resource


def make_disk_ws(tmp_path) -> tuple[Workspace, object]:
    disk_root = tmp_path / "disk_root"
    disk_root.mkdir()
    resource = DiskResource(root=str(disk_root))
    ws = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, disk_root


def memory_create_file(resource: RAMResource, path: str, content: bytes):
    accessor = resource.accessor
    parts = path.strip("/").split("/")
    for i in range(1, len(parts)):
        d = "/" + "/".join(parts[:i])
        if d not in accessor.store.dirs:
            try:
                asyncio.run(mem_mkdir(accessor, d))
            except (FileExistsError, ValueError):
                pass
    asyncio.run(mem_write(accessor, path, content))


def run(ws: Workspace, cmd: str) -> str:

    async def _run():
        io = await ws.execute(cmd)
        return await io.stdout_str()

    return asyncio.run(_run())


def run_exit(ws: Workspace, cmd: str) -> int:
    io = asyncio.run(ws.execute(cmd))
    return io.exit_code


def make_resource_ws(request, tmp_path, files: dict[str, bytes]):
    if request.param == "s3":
        objects: dict[str, bytes] = {}
        for path, content in files.items():
            objects[path] = content
        ws = make_s3_ws(objects)
        with patch_async_session(objects):
            yield ws
    elif request.param == "ram":
        ws, resource = make_memory_ws()
        for path, content in files.items():
            memory_create_file(resource, "/" + path, content)
        yield ws
    else:
        ws, disk_root = make_disk_ws(tmp_path)
        for path, content in files.items():
            full = disk_root / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(content)
        yield ws

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
from io import BytesIO
from types import SimpleNamespace

from mirage import MountMode, Workspace
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)

CHUNK_SIZE = 8192
DATA = b"x" * (CHUNK_SIZE * 3)


class TrackingContents(BytesIO):

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.bytes_read = 0

    def read(self, size: int = -1) -> bytes:
        chunk = super().read(size)
        self.bytes_read += len(chunk)
        return chunk


class FakeFiles:

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.contents: TrackingContents | None = None

    def get_metadata(self, path: str) -> SimpleNamespace:
        return SimpleNamespace(content_length=len(self.data),
                               last_modified=None,
                               is_directory=False)

    def download(self, path: str) -> SimpleNamespace:
        self.contents = TrackingContents(self.data)
        return SimpleNamespace(contents=self.contents)


class FakeClient:

    def __init__(self, data: bytes) -> None:
        self.files = FakeFiles(data)


async def wait_for_drains(ws: Workspace) -> None:
    while ws.cache._drain_tasks:
        tasks = tuple(ws.cache._drain_tasks.values())
        await asyncio.gather(*tasks)


async def main() -> None:
    client = FakeClient(DATA)
    resource = DatabricksVolumeResource(
        DatabricksVolumeConfig(catalog="catalog",
                               schema="schema",
                               volume="volume"),
        client=client,
    )
    ws = Workspace({"/dbx/": resource}, mode=MountMode.READ)
    path = "/dbx/sample.bin"
    ws.max_drain_bytes = 4096
    try:
        result = await ws.execute(f"cat {path} | head -c 100")
        out = await result.stdout_str()
        await wait_for_drains(ws)
        contents = client.files.contents
        cached = await ws.cache.get(path)
        assert contents is not None
        assert len(out.encode()) == 100
        assert contents.bytes_read == CHUNK_SIZE
        assert contents.closed
        assert cached is None
        print("=== databricks_volume:bounded_drain ===")
        print(f"bytes={contents.bytes_read} "
              f"cache_entry={cached is not None} "
              f"source_closed={contents.closed}")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

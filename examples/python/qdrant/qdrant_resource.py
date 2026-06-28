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

from build_collection import MODEL, build_collection
from qdrant_client import QdrantClient

from mirage import MountMode, Workspace
from mirage.resource.qdrant import QdrantConfig, QdrantResource


def _client() -> QdrantClient:
    url = os.environ.get("QDRANT_URL")
    if url:
        return QdrantClient(url=url, api_key=os.environ.get("QDRANT_API_KEY"))
    return QdrantClient(host=os.environ.get("QDRANT_HOST", "localhost"),
                        port=int(os.environ.get("QDRANT_PORT", "6333")))


async def show(ws: Workspace, cmd: str) -> None:
    print(f"\n=== {cmd} ===")
    result = await ws.execute(cmd)
    print((await result.stdout_str()).rstrip())


async def main() -> None:
    client = _client()
    build_collection(client, "fashion")

    config = QdrantConfig(
        url=os.environ.get("QDRANT_URL"),
        api_key=os.environ.get("QDRANT_API_KEY"),
        host=os.environ.get("QDRANT_HOST", "localhost"),
        port=int(os.environ.get("QDRANT_PORT", "6333")),
        collection="fashion",
        group_by=["gender", "articleType", "baseColour"],
        id_field="id",
        text_field="productDisplayName",
        blob_field="image_b64",
        blob_ext="jpg",
        embedding_model=MODEL,
        search_limit=4,
    )
    ws = Workspace({"/fashion/": QdrantResource(config)}, mode=MountMode.READ)

    print("=== mounted Qdrant collection 'fashion' at /fashion/ ===")

    await show(ws, "ls /fashion/")
    await show(ws, "tree -L 2 /fashion/")
    await show(ws, "ls /fashion/Men/Shoes/White")
    await show(ws, "cat /fashion/Men/Shoes/White/3.txt")
    await show(ws, "cat /fashion/Men/Shoes/White/3.json")

    print("\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===")
    r = await ws.execute("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
    print(f"  image size: {(await r.stdout_str()).strip()} bytes")

    await show(ws, 'search "white running sneakers" /fashion')

    await show(ws, "grep -ril blue /fashion/Women")
    await show(ws, "rg -li running /fashion/Men")

    print("\n=== find /fashion -name '*.txt' | wc -l ===")
    r = await ws.execute("find /fashion -name '*.txt' | wc -l")
    print(f"  products: {(await r.stdout_str()).strip()}")


if __name__ == "__main__":
    asyncio.run(main())

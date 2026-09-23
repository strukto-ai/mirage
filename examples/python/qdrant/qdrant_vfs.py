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

from build_collection import MODEL, build_collection, build_lineage_collection
from qdrant_client import QdrantClient

from mirage import MountMode, Workspace
from mirage.types import PathSpec
from mirage.vfs.qdrant import QdrantConfig, QdrantVFS


def _connection() -> dict[str, str | int | None]:
    return {
        "url": os.environ.get("QDRANT_URL"),
        "api_key": os.environ.get("QDRANT_API_KEY"),
        "host": os.environ.get("QDRANT_HOST", "localhost"),
        "port": int(os.environ.get("QDRANT_PORT", "6333")),
    }


def _client() -> QdrantClient:
    url = os.environ.get("QDRANT_URL")
    if url:
        return QdrantClient(url=url, api_key=os.environ.get("QDRANT_API_KEY"))
    return QdrantClient(host=os.environ.get("QDRANT_HOST", "localhost"),
                        port=int(os.environ.get("QDRANT_PORT", "6333")))


async def show(ws: Workspace, cmd: str) -> None:
    print(f"\n=== {cmd} ===")
    result = await ws.shell(cmd)
    print((await result.stdout_str()).rstrip())


async def main() -> None:
    client = _client()
    build_collection(client, "fashion")
    build_lineage_collection(client, "company_docs")

    fashion = QdrantConfig(
        **_connection(),
        collection="fashion",
        group_by=["gender", "articleType", "baseColour"],
        id_field="id",
        text_field="productDisplayName",
        blob_field="image_b64",
        blob_ext="jpg",
        embedding_model=MODEL,
        search_limit=4,
    )
    # Chunks grouped by the document they came from: `metadata.source` is
    # a nested payload path, `basename_fields` lists it by file name, and
    # `name_field` puts the page label in front of the point id.
    docs = QdrantConfig(
        **_connection(),
        collection="company_docs",
        group_by=["metadata.source"],
        basename_fields=["metadata.source"],
        name_field="metadata.page",
        text_field="page_content",
        embedding_model=MODEL,
        search_limit=2,
    )
    ws = Workspace(
        {
            "/fashion/": QdrantVFS(fashion),
            "/docs/": QdrantVFS(docs),
        },
        mode=MountMode.READ,
    )

    print("=== mounted Qdrant collection 'fashion' at /fashion/ ===")

    await show(ws, "ls /fashion/")
    await show(ws, "tree -L 2 /fashion/")
    await show(ws, "ls /fashion/Men/Shoes/White")
    await show(ws, "cat /fashion/Men/Shoes/White/3.txt")
    await show(ws, "cat /fashion/Men/Shoes/White/3.json")

    print("\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===")
    r = await ws.shell("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
    print(f"  image size: {(await r.stdout_str()).strip()} bytes")

    # chmod/chown/touch never hit the Qdrant API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /fashion/Men/Shoes/White/3.json ===")
    meta_res = await ws.shell(
        'chmod 640 "/fashion/Men/Shoes/White/3.json"'
        ' && chown 500:dev "/fashion/Men/Shoes/White/3.json"'
        ' && touch -t 202601021530 "/fashion/Men/Shoes/White/3.json"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/fashion/Men/Shoes/White/3.json"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    await show(ws, 'search "white running sneakers" /fashion')

    await show(ws, "grep -ril blue /fashion/Women")
    await show(ws, "rg -li running /fashion/Men")

    print("\n=== find /fashion -name '*.txt' | wc -l ===")
    r = await ws.shell("find /fashion -name '*.txt' | wc -l")
    print(f"  products: {(await r.stdout_str()).strip()}")

    print("\n=== mounted Qdrant collection 'company_docs' at /docs/ ===")
    # One directory per source document, named by its basename; each
    # chunk is `<page>__<point-id>.txt` beside its `.json` payload.
    await show(ws, "tree /docs/")
    await show(ws, "cat /docs/refund-2026.pdf/004__102.txt")
    await show(ws, "cat /docs/refund-2026.pdf/004__102.json")
    await show(ws, 'search "how long does a refund take" /docs')


if __name__ == "__main__":
    asyncio.run(main())

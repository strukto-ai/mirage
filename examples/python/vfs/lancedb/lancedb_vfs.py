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
import tempfile

from build_table import build_table

from mirage import MountMode, Workspace
from mirage.vfs.lancedb import LanceDBConfig, LanceDBVFS


async def main() -> None:
    uri = tempfile.mkdtemp(prefix="mirage-fashion-")
    build_table(uri, "fashion")

    config = LanceDBConfig(
        uri=uri,
        table="fashion",
        group_by=["gender", "articleType", "baseColour"],
        id_column="id",
        title_column="productDisplayName",
        blob_column="image_bytes",
        blob_ext="jpg",
        vector_column="vector",
        search_limit=4,
    )
    vfs = LanceDBVFS(config)
    with Workspace({"/fashion/": vfs}, mode=MountMode.READ) as ws:
        print(
            f"=== VFS MODE: LanceDB table 'fashion' ({uri}) at /fashion/ ==="
        )

        print("\n--- list /fashion ---")
        for entry in os.listdir("/fashion"):
            print(f"  {entry}")

        print("\n--- list /fashion/Men/Shoes/White ---")
        for entry in os.listdir("/fashion/Men/Shoes/White"):
            print(f"  {entry}")

        print("\n--- read /fashion/Men/Shoes/White/3.md ---")
        with open("/fashion/Men/Shoes/White/3.md") as f:
            for line in f.read().rstrip().splitlines():
                print(f"  {line}")

        print(
            "\n--- read /fashion/Men/Shoes/White/3.jpg (raw image bytes) ---"
        )
        with open("/fashion/Men/Shoes/White/3.jpg", "rb") as f:
            image = f.read()
        print(f"  size: {len(image)} bytes, magic: {image[:3].hex()}")

        print("\n--- stat ---")
        for path in ("/fashion/Men/Shoes", "/fashion/Men/Shoes/White/3.md"):
            kind = "directory" if os.path.isdir(path) else "file"
            print(f"  {path}: {kind}")

        # Every product is a card under gender/articleType/baseColour.
        print("\n--- walk /fashion: product cards ---")
        cards = sorted(
            f"{root}/{name}"
            for root, _, files in os.walk("/fashion")
            for name in files
            if name.endswith(".md")
        )
        for card in cards:
            print(f"  {card}")
        print(f"  total: {len(cards)}")

        print("\n--- shell view ---")
        r = await ws.shell('search "white running sneakers" /fashion')
        hits = [
            line
            for line in (await r.stdout_str()).splitlines()
            if line.startswith("/fashion/")
        ]
        for hit in hits:
            print(f"  {hit}")

        records = ws.vfs.records
        total = sum(record.bytes for record in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


if __name__ == "__main__":
    asyncio.run(main())

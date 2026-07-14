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
import tempfile

from build_table import build_table

from mirage import MountMode, Workspace
from mirage.resource.lancedb import LanceDBConfig, LanceDBResource
from mirage.types import PathSpec


async def show(ws: Workspace, cmd: str) -> None:
    print(f"\n=== {cmd} ===")
    result = await ws.execute(cmd)
    print((await result.stdout_str()).rstrip())


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
        text_column="productDisplayName",
        vector_column="vector",
        search_limit=4,
    )
    ws = Workspace({"/fashion/": LanceDBResource(config)}, mode=MountMode.READ)

    print(f"=== mounted LanceDB table 'fashion' ({uri}) at /fashion/ ===")

    await show(ws, "ls /fashion/")
    await show(ws, "tree -L 2 /fashion/")
    await show(ws, "ls /fashion/Men/Shoes")
    await show(ws, "cat /fashion/Men/Shoes/White/3.md")
    await show(ws, "head -n 3 /fashion/Men/Shoes/White/3.md")
    await show(ws, "tail -n 2 /fashion/Men/Shoes/White/3.md")

    print("\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===")
    r = await ws.execute("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
    print(f"  image size: {(await r.stdout_str()).strip()} bytes")

    # chmod/chown/touch never hit the LanceDB API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /fashion/Men/Shoes/White/3.md ===")
    meta_res = await ws.execute(
        'chmod 640 "/fashion/Men/Shoes/White/3.md"'
        ' && chown 500:dev "/fashion/Men/Shoes/White/3.md"'
        ' && touch -t 202601021530 "/fashion/Men/Shoes/White/3.md"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/fashion/Men/Shoes/White/3.md"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    await show(ws, 'search "white running sneakers" /fashion')

    await show(ws, "grep -ril blue /fashion/Women")
    await show(ws, "rg -li running /fashion/Men")

    print("\n=== find /fashion -name '*.md' | wc -l ===")
    r = await ws.execute("find /fashion -name '*.md' | wc -l")
    print(f"  product cards: {(await r.stdout_str()).strip()}")


if __name__ == "__main__":
    asyncio.run(main())

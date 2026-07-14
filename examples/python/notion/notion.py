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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.notion import NotionConfig, NotionResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = NotionConfig(api_key=os.environ["NOTION_API_KEY"])
resource = NotionResource(config=config)


async def run(ws: Workspace, cmd: str, limit: int = 1500) -> str:
    print(f"=== {cmd} ===")
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    err = (await result.stderr_str()).strip()
    print(out[:limit] if out.strip() else "(empty)")
    if err:
        print(f"  [stderr] {err[:300]}")
    print(f"  [exit={result.exit_code}]\n")
    return out


async def first_entry(ws: Workspace, path: str) -> str:
    result = await ws.execute(f"ls {path}")
    out = (await result.stdout_str()).strip()
    if not out:
        return ""
    return os.path.basename(out.splitlines()[0].rstrip("/"))


async def explore_pages(ws: Workspace) -> None:
    print("\n########## PAGES ##########\n")
    await run(ws, "ls /notion/pages/")
    page = await first_entry(ws, "/notion/pages/")
    if not page:
        print("No shared pages available\n")
        return
    base = f"/notion/pages/{page}"

    await run(ws, f"ls {base}/")
    await run(ws, f"cat {base}/page.json", limit=1200)
    await run(ws, f"head -n 5 {base}/page.json")
    await run(ws, f"tail -n 5 {base}/page.json")
    await run(ws, f"wc -l {base}/page.json")
    await run(ws, f"stat {base}/page.json")

    # chmod/chown/touch never hit the Notion API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {base}/page.json ===")
    meta_res = await ws.execute(f'chmod 640 "{base}/page.json"'
                                f' && chown 500:dev "{base}/page.json"'
                                f' && touch -t 202601021530 "{base}/page.json"'
                                )
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path(f"{base}/page.json"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")
    await run(ws, f'jq ".title" {base}/page.json')
    await run(ws, f'jq ".page_id" {base}/page.json')
    await run(ws, f'jq ".parent_type" {base}/page.json')
    await run(ws, f"basename {base}/page.json")
    await run(ws, f"dirname {base}/page.json")
    await run(ws, f"realpath {base}/page.json")
    await run(ws, f"tree -L 1 {base}/")
    await run(ws, f'find {base}/ -name "*.json"')
    await run(ws, f"echo {base}/*.json")


async def explore_databases(ws: Workspace) -> None:
    print("\n########## DATABASES ##########\n")
    await run(ws, "ls /notion/databases/")
    db = await first_entry(ws, "/notion/databases/")
    if not db:
        print("No shared databases available\n")
        return
    base = f"/notion/databases/{db}"

    await run(ws, f"ls {base}/")
    await run(ws, f"stat {base}/")
    await run(ws, f"stat {base}/database.json")
    await run(ws, f"cat {base}/database.json", limit=1500)
    await run(ws, f'jq ".database_id" {base}/database.json')
    await run(ws, f'jq ".title" {base}/database.json')
    await run(ws, f'jq ".properties | keys" {base}/database.json')
    await run(ws, f"wc -l {base}/database.json")
    await run(ws, f"head -n 8 {base}/database.json")
    await run(ws, f"tail -n 5 {base}/database.json")
    await run(ws, f"basename {base}/database.json")
    await run(ws, f"dirname {base}/database.json")
    await run(ws, f"tree -L 1 {base}/")
    await run(ws, f'find {base}/ -name "database.json"')
    await run(ws, f"echo {base}/*")

    row = ""
    result = await ws.execute(f"ls {base}/")
    for line in (await result.stdout_str()).strip().splitlines():
        name = os.path.basename(line.rstrip("/"))
        if name != "database.json":
            row = name
            break
    if not row:
        print("Database has no row pages\n")
        return
    row_base = f"{base}/{row}"
    print(f"--- row page: {row} ---\n")
    await run(ws, f"ls {row_base}/")
    await run(ws, f"stat {row_base}/page.json")
    await run(ws, f"cat {row_base}/page.json", limit=1200)
    await run(ws, f'jq ".parent_type" {row_base}/page.json')
    await run(ws, f'jq ".parent_id" {row_base}/page.json')


async def explore_cross_cutting(ws: Workspace) -> None:
    print("\n########## CROSS-CUTTING ##########\n")
    await run(ws, "ls /notion/")
    await run(ws, "tree -L 2 /notion/")
    await run(ws, "notion-search --query a", limit=800)
    await run(ws, 'grep -rl "page_id" /notion/pages/', limit=800)
    await run(ws, 'rg -c "title" /notion/databases/', limit=800)


async def main() -> None:
    ws = Workspace({"/notion": resource}, mode=MountMode.READ)
    await explore_pages(ws)
    await explore_databases(ws)
    await explore_cross_cutting(ws)


if __name__ == "__main__":
    asyncio.run(main())

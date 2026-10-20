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
import shlex

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.commands.cli.builtin.ntn import NTN
from mirage.types import PathSpec
from mirage.vfs.notion import NotionConfig, NotionVFS

load_dotenv(".env.development")

config = NotionConfig(api_key=os.environ["NOTION_API_KEY"])
vfs = NotionVFS(config=config)


async def run(ws: Workspace, cmd: str, limit: int = 1500) -> str:
    print(f"=== {cmd} ===")
    result = await ws.shell(cmd)
    out = await result.stdout_str()
    err = (await result.stderr_str()).strip()
    print(out[:limit] if out.strip() else "(empty)")
    if err:
        print(f"  [stderr] {err[:300]}")
    print(f"  [exit={result.exit_code}]\n")
    return out


async def first_entry(ws: Workspace, path: str) -> str:
    result = await ws.shell(f"ls {shlex.quote(path)}")
    out = (await result.stdout_str()).strip()
    if not out:
        return ""
    return os.path.basename(out.splitlines()[0].rstrip("/"))


async def pick_child(ws: Workspace, path: str, skip: str) -> str:
    result = await ws.shell(f"ls {shlex.quote(f'{path}/')}")
    for line in (await result.stdout_str()).strip().splitlines():
        name = os.path.basename(line.rstrip("/"))
        if name != skip:
            return name
    return ""


async def explore_pages(ws: Workspace) -> None:
    print("\n########## PAGES ##########\n")
    await run(ws, "ls /notion/pages/")
    page = await first_entry(ws, "/notion/pages/")
    if not page:
        print("No shared pages available\n")
        return
    base = f"/notion/pages/{page}"

    await run(ws, f"ls {shlex.quote(f'{base}/')}")
    await run(ws, f"cat {shlex.quote(f'{base}/page.json')}", limit=1200)
    await run(ws, f"head -n 5 {shlex.quote(f'{base}/page.json')}")
    await run(ws, f"tail -n 5 {shlex.quote(f'{base}/page.json')}")
    await run(ws, f"wc -l {shlex.quote(f'{base}/page.json')}")
    await run(ws, f"stat {shlex.quote(f'{base}/page.json')}")

    # chmod/chown/touch never hit the Notion API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {base}/page.json ===")
    meta_res = await ws.shell(
        f"chmod 640 {shlex.quote(f'{base}/page.json')}"
        f" && chown 500:dev {shlex.quote(f'{base}/page.json')}"
        f" && touch -t 202601021530 {shlex.quote(f'{base}/page.json')}"
    )
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path(f"{base}/page.json")
    )
    meta_mode = oct(meta_st.mode)[2:] if meta_st.mode is not None else "-"
    print(
        f"  dispatch stat: mode={meta_mode} uid={meta_st.uid} "
        f"gid={meta_st.gid} mtime={meta_st.modified}"
    )
    await run(ws, f'jq ".title" {shlex.quote(f"{base}/page.json")}')
    await run(ws, f'jq ".page_id" {shlex.quote(f"{base}/page.json")}')
    await run(ws, f'jq ".parent_type" {shlex.quote(f"{base}/page.json")}')
    await run(ws, f"basename {shlex.quote(f'{base}/page.json')}")
    await run(ws, f"dirname {shlex.quote(f'{base}/page.json')}")
    await run(ws, f"realpath {shlex.quote(f'{base}/page.json')}")
    await run(ws, f"tree -L 1 {shlex.quote(f'{base}/')}")
    await run(ws, f'find {shlex.quote(f"{base}/")} -name "*.json"')
    await run(ws, f"echo {shlex.quote(f'{base}/')}*.json")


async def explore_databases(ws: Workspace) -> None:
    print("\n########## DATABASES ##########\n")
    await run(ws, "ls /notion/databases/")
    db = await first_entry(ws, "/notion/databases/")
    if not db:
        print("No shared databases available\n")
        return
    base = f"/notion/databases/{db}"

    await run(ws, f"ls {shlex.quote(f'{base}/')}")
    await run(ws, f"stat {shlex.quote(f'{base}/')}")
    await run(ws, f"stat {shlex.quote(f'{base}/database.json')}")
    await run(ws, f"cat {shlex.quote(f'{base}/database.json')}", limit=1500)
    await run(ws, f'jq ".database_id" {shlex.quote(f"{base}/database.json")}')
    await run(ws, f'jq ".title" {shlex.quote(f"{base}/database.json")}')
    # The container carries data source stubs, not a column schema: since
    # 2025-09-03 `properties` lives on the data source one level down.
    await run(ws, f'jq ".data_sources" {shlex.quote(f"{base}/database.json")}')
    await run(ws, f"wc -l {shlex.quote(f'{base}/database.json')}")
    await run(ws, f"head -n 8 {shlex.quote(f'{base}/database.json')}")
    await run(ws, f"tail -n 5 {shlex.quote(f'{base}/database.json')}")
    await run(ws, f"basename {shlex.quote(f'{base}/database.json')}")
    await run(ws, f"dirname {shlex.quote(f'{base}/database.json')}")
    await run(ws, f"tree -L 2 {shlex.quote(f'{base}/')}")
    await run(ws, f'find {shlex.quote(f"{base}/")} -name "database.json"')
    await run(ws, f"echo {shlex.quote(f'{base}/')}*")

    source = await pick_child(ws, base, "database.json")
    if not source:
        print("Database has no data sources\n")
        return
    source_base = f"{base}/{source}"
    print(f"--- data source: {source} ---\n")
    await run(ws, f"ls {shlex.quote(f'{source_base}/')}")
    await run(
        ws,
        f"cat {shlex.quote(f'{source_base}/data_source.json')}",
        limit=1500,
    )
    await run(
        ws,
        f'jq ".properties | keys" '
        f"{shlex.quote(f'{source_base}/data_source.json')}",
    )

    await run(
        ws, f"head -n 2 {shlex.quote(f'{source_base}/rows.jsonl')}", limit=1200
    )
    await run(ws, f"wc -l {shlex.quote(f'{source_base}/rows.jsonl')}")
    await run(ws, f'jq -r ".title" {shlex.quote(f"{source_base}/rows.jsonl")}')
    # A row's cells ride on its line, as Notion's own property objects,
    # answering to the schema in the data_source.json above.
    await run(
        ws,
        f"head -n 1 {shlex.quote(f'{source_base}/rows.jsonl')}"
        ' | jq ".properties | keys"',
    )

    row = (
        await run(
            ws,
            f"head -n 1 {shlex.quote(f'{source_base}/rows.jsonl')}"
            ' | jq -r ".path"',
        )
    ).strip()
    if not row:
        print("Data source has no rows\n")
        return
    row_json = f"{source_base}/{row}"
    print(f"--- row page: {row} ---\n")
    await run(ws, f"stat {shlex.quote(row_json)}")
    await run(ws, f"cat {shlex.quote(row_json)}", limit=1200)
    await run(ws, f'jq ".parent_type" {shlex.quote(row_json)}')
    await run(ws, f'jq ".markdown" {shlex.quote(row_json)}')


async def explore_cross_cutting(ws: Workspace) -> None:
    print("\n########## CROSS-CUTTING ##########\n")
    await run(ws, "ls /notion/")
    await run(ws, "tree -L 2 /notion/")
    # There is no `ntn search`: /search is reached through `ntn api`,
    # exactly as the official CLI reaches it.
    await run(ws, 'ntn api v1/search -d \'{"query":"a"}\'', limit=800)
    await run(ws, 'grep -rl "page_id" /notion/pages/', limit=800)
    await run(ws, 'rg -c "title" /notion/databases/', limit=800)


async def main() -> None:
    ws = Workspace({"/notion": vfs}, mode=MountMode.READ)
    ws.register_cli("ntn", NTN, config.model_dump())
    await explore_pages(ws)
    await explore_databases(ws)
    await explore_cross_cutting(ws)
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

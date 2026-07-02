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
from mirage.resource.postgres import PostgresConfig, PostgresResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = PostgresConfig(
    dsn=os.environ["POSTGRES_DSN"],
    max_read_rows=200,
    max_read_bytes=1024 * 1024,
)
resource = PostgresResource(config=config)


async def _run(ws, cmd):
    print(f"\n>>> {cmd}")
    r = await ws.execute(cmd)
    out = (await r.stdout_str()).strip()
    err = await r.stderr_str()
    if out:
        for line in out.splitlines()[:10]:
            print(f"  {line[:140]}")
        total = len(out.splitlines())
        if total > 10:
            print(f"  ... ({total} lines total)")
    if err:
        print(f"  [stderr] {err.strip()[:160]}")
    if not out and not err:
        print(f"  (empty, exit={r.exit_code})")
    return r


async def main():
    ws = Workspace({"/pg": resource}, mode=MountMode.READ)

    print("=" * 60)
    print("LISTING (ls / tree)")
    print("=" * 60)

    await _run(ws, "ls /pg/")
    await _run(ws, "ls /pg/public/")
    await _run(ws, "ls /pg/public/tables/")
    await _run(ws, "ls /pg/public/views/")
    await _run(ws, "tree -L 2 /pg/public/")

    print("\n" + "=" * 60)
    print("SYNTHETIC JSON (database.json + per-entity schema.json)")
    print("=" * 60)

    await _run(ws, "cat /pg/database.json | head -n 30")

    table = "context_info"
    sch = f"/pg/public/tables/{table}/schema.json"
    await _run(ws, f'cat "{sch}" | head -n 25')

    print("\n" + "=" * 60)
    print("STAT and METADATA")
    print("=" * 60)

    fp = f"/pg/public/tables/{table}/rows.jsonl"
    await _run(ws, f'stat "{fp}"')

    # chmod/chown/touch never hit Postgres: attrs land in the workspace
    # namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {fp} ===")
    meta_res = await ws.execute(f'chmod 640 "{fp}" && chown 500:dev "{fp}"'
                                f' && touch -t 202601021530 "{fp}"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    try:
        meta_st, _ = await ws.dispatch("stat", PathSpec.from_str_path(fp))
        print(
            f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
            f"gid={meta_st.gid} mtime={meta_st.modified}")
    except FileNotFoundError:
        print("  dispatch stat: target missing in this environment")

    print("\n" + "=" * 60)
    print("HEAD / TAIL / WC (predicate pushdown to SQL)")
    print("=" * 60)

    await _run(ws, f'head -n 3 "{fp}"')
    await _run(ws, f'tail -n 3 "{fp}"')
    await _run(ws, f'wc -l "{fp}"')

    print("\n" + "=" * 60)
    print("CAT with SIZE GUARD")
    print("=" * 60)
    print("(this should error: table has more rows than max_read_rows=200)")

    await _run(ws, f'cat "{fp}"')

    print("\n" + "=" * 60)
    print("GREP at different scopes (ILIKE pushdown)")
    print("=" * 60)

    await _run(ws, f'grep system "{fp}"')
    await _run(ws, f'grep -c system "{fp}"')
    await _run(ws, 'grep system /pg/public/tables/')
    await _run(ws, 'grep system /pg/public/')

    print("\n" + "=" * 60)
    print("RG at schema scope")
    print("=" * 60)

    await _run(ws, "rg system /pg/public/")

    print("\n" + "=" * 60)
    print("JQ over rows.jsonl (slice with head first to stay under guard)")
    print("=" * 60)

    await _run(ws, f'head -n 20 "{fp}" | jq -r ".[] | .id"')
    await _run(ws, f'head -n 20 "{fp}" | jq -r ".[] | .file_name"')

    print("\n" + "=" * 60)
    print("FIND")
    print("=" * 60)

    await _run(ws, 'find /pg/public/tables/ -name rows.jsonl')

    print("\n" + "=" * 60)
    print("CD + relative paths")
    print("=" * 60)

    await ws.execute("cd /pg/public/tables")
    await _run(ws, "pwd")
    await _run(ws, "ls")

    await resource.accessor.close()


if __name__ == "__main__":
    asyncio.run(main())

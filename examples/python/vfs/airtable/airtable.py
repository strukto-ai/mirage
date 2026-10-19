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
from mirage.vfs.airtable import AirtableConfig, AirtableVFS

load_dotenv(".env.development")

config = AirtableConfig(token=os.environ["AIRTABLE_TOKEN"])
vfs = AirtableVFS(config=config)


async def run(ws: Workspace, cmd: str) -> str:
    result = await ws.shell(cmd)
    print(f"$ {cmd}")
    if result.exit_code != 0:
        print(
            f"  exit={result.exit_code}  "
            f"{(await result.stderr_str()).strip()[:200]}"
        )
    out = (await result.stdout_str()).rstrip()
    for line in out.splitlines()[:10]:
        print(f"  {line[:200]}")
    return out


async def main() -> None:
    ws = Workspace({"/airtable": vfs}, mode=MountMode.READ)
    try:
        bases = (await run(ws, "ls /airtable/bases")).splitlines()
        if not bases:
            print("No bases visible to this token")
            return
        base = f"/airtable/bases/{bases[0]}"
        await run(ws, f"cat {base}/base.json")
        tables = [
            name
            for name in (await run(ws, f"ls {base}")).splitlines()
            if name != "base.json"
        ]
        if not tables:
            return
        table = f"{base}/{tables[0]}"
        await run(
            ws,
            f"jq -r '.fields[] | .field_name + \": \" + .type' "
            f"{table}/table.json",
        )
        # head pushes its count into maxRecords: one request, not the table
        await run(ws, f"head -n 3 {table}/records.jsonl | jq -c .fields")
        await run(ws, f"ls {table}/views")
        await run(
            ws, "cat /airtable/bases/Missing__appMissing00000001/base.json"
        )
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

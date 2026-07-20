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
import json
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.gsheets import GSheetsConfig, GSheetsResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = GSheetsConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GSheetsResource(config=config)


async def main() -> None:
    ws = Workspace({"/gsheets": resource}, mode=MountMode.WRITE)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /gsheets/__nf_missing__.txt",
                "head /gsheets/__nf_missing__.txt",
                "stat /gsheets/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /gsheets/ ===")
    r = await ws.execute("ls /gsheets/")
    print(await r.stdout_str())

    print("=== ls /gsheets/owned/ (first 5) ===")
    r = await ws.execute("ls /gsheets/owned/ | head -n 5")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== cat ===")
    r = await ws.execute(f"cat /gsheets/owned/{first}")
    print((await r.stdout_str())[:300])

    print("\n=== head -n 20 ===")
    r = await ws.execute(f"head -n 20 /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== tail -n 10 ===")
    r = await ws.execute(f"tail -n 10 /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== wc ===")
    r = await ws.execute(f"wc /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== stat ===")
    r = await ws.execute(f"stat /gsheets/owned/{first}")
    print(await r.stdout_str())

    # chmod/chown/touch never hit the Sheets API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on /gsheets/owned/{first} ===")
    r = await ws.execute(f'chmod 640 "/gsheets/owned/{first}"'
                         f' && chown 500:dev "/gsheets/owned/{first}"'
                         f' && touch -t 202601021530 "/gsheets/owned/{first}"')
    print(f"  chmod/chown/touch exit={r.exit_code}")
    st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path(f"/gsheets/owned/{first}"))
    print(f"  dispatch stat: mode={oct(st.mode)[2:]} uid={st.uid} "
          f"gid={st.gid} mtime={st.modified}")

    print("=== jq .properties.title ===")
    r = await ws.execute(f'jq ".properties.title" /gsheets/owned/{first}')
    print(await r.stdout_str())

    print('=== jq ".sheets | length" ===')
    r = await ws.execute(f'jq ".sheets | length" /gsheets/owned/{first}')
    print(await r.stdout_str())

    print("=== nl ===")
    r = await ws.execute(f"nl /gsheets/owned/{first} | head -n 10")
    print(await r.stdout_str())

    print("=== tree /gsheets/ ===")
    r = await ws.execute("tree /gsheets/")
    print((await r.stdout_str())[:500])

    print("\n=== find /gsheets/owned/ ===")
    r = await ws.execute(
        "find /gsheets/owned/ -name '*.gsheet.json' | head -n 5")
    print(await r.stdout_str())

    print("=== grep title ===")
    r = await ws.execute(f"grep title /gsheets/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("\n=== rg title ===")
    r = await ws.execute(f"rg title /gsheets/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("\n=== basename ===")
    r = await ws.execute(f"basename /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== dirname ===")
    r = await ws.execute(f"dirname /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== realpath ===")
    r = await ws.execute(f"realpath /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== gws sheets spreadsheets create ===")
    body = json.dumps({"properties": {"title": "MIRAGE Sheets Test"}})
    r = await ws.execute("gws sheets spreadsheets create"
                         f" --json '{body}'")
    sheet = json.loads(await r.stdout_str())
    sheet_id = sheet["spreadsheetId"]
    print(f"Created: {sheet_id}")

    print("\n=== gws sheets +write ===")
    params = json.dumps({
        "spreadsheetId": sheet_id,
        "range": "Sheet1!A1",
        "valueInputOption": "USER_ENTERED",
    })
    values = json.dumps({
        "values": [
            ["Name", "Age", "City"],
            ["Alice", "30", "NYC"],
            ["Bob", "25", "SF"],
        ]
    })
    r = await ws.execute(f"gws sheets +write"
                         f" --params '{params}' --json '{values}'")
    print(f"Written: {(await r.stdout_str())[:80]}")

    print("\n=== gws sheets +read ===")
    r = await ws.execute(f'gws sheets +read'
                         f' --spreadsheet {sheet_id}'
                         f' --range "Sheet1!A1:C3"')
    print(f"Values: {await r.stdout_str()}")

    print("=== gws sheets +append ===")
    r = await ws.execute(f"gws sheets +append"
                         f" --spreadsheet {sheet_id}"
                         f" --values Diana,28,Chicago")
    print(f"Appended: {(await r.stdout_str())[:80]}")

    print("\n=== gws sheets +read (all) ===")
    r = await ws.execute(f'gws sheets +read'
                         f' --spreadsheet {sheet_id}'
                         f' --range Sheet1')
    print(f"All: {await r.stdout_str()}")

    print("\n=== gws sheets spreadsheets batchUpdate ===")
    batch_body = json.dumps({
        "requests": [{
            "updateSpreadsheetProperties": {
                "properties": {
                    "title": "MIRAGE Sheets Test (Updated)"
                },
                "fields": "title",
            }
        }]
    })
    batch_params = json.dumps({"spreadsheetId": sheet_id})
    r = await ws.execute("gws sheets spreadsheets batchUpdate"
                         f" --params '{batch_params}' --json '{batch_body}'")
    print(f"BatchUpdate: {(await r.stdout_str())[:80]}")

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}"
    print(f"\nOpen: {url}")


if __name__ == "__main__":
    asyncio.run(main())

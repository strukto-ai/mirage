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

load_dotenv(".env.development")

config = GSheetsConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GSheetsResource(config=config)


async def main():
    ws = Workspace({"/gsheets": resource}, mode=MountMode.WRITE)

    r = await ws.execute("ls /gsheets/owned/ | head -n 3")
    print("=== ls (first 3) ===")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== plan: cat ===")
    dr = await ws.execute(f"cat /gsheets/owned/{first}", provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== plan: grep ===")
    dr = await ws.execute(f"grep title /gsheets/owned/{first}", provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== jq .properties.title ===")
    r = await ws.execute(f'jq ".properties.title" /gsheets/owned/{first}')
    print(await r.stdout_str())

    print('=== jq ".sheets | length" ===')
    r = await ws.execute(f'jq ".sheets | length" /gsheets/owned/{first}')
    print(await r.stdout_str())

    print("=== head -c 200 ===")
    r = await ws.execute(f"head -c 200 /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== grep title ===")
    r = await ws.execute(f"grep title /gsheets/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("=== tail -c 200 ===")
    r = await ws.execute(f"tail -c 200 /gsheets/owned/{first}")
    print(await r.stdout_str())

    print("=== gws-sheets-spreadsheets-create ===")
    body = json.dumps({"properties": {"title": "MIRAGE Sheets Test"}})
    r = await ws.execute("gws-sheets-spreadsheets-create"
                         f" --json '{body}'")
    out = await r.stdout_str()
    if r.exit_code != 0 or not out.strip():
        err = (await r.stderr_str()).strip() or "empty response"
        print(f"  create failed (exit={r.exit_code}): {err}")
        return
    sheet = json.loads(out)
    sheet_id = sheet["spreadsheetId"]
    print(f"Created: {sheet_id}")

    print("\n=== gws-sheets-write ===")
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
    r = await ws.execute(f"gws-sheets-write"
                         f" --params '{params}' --json '{values}'")
    print(f"Written: {(await r.stdout_str())[:80]}")

    print("\n=== gws-sheets-read ===")
    r = await ws.execute(f'gws-sheets-read'
                         f' --spreadsheet {sheet_id}'
                         f' --range "Sheet1!A1:C3"')
    print(f"Values: {await r.stdout_str()}")

    print("=== gws-sheets-append ===")
    r = await ws.execute(f"gws-sheets-append"
                         f" --spreadsheet {sheet_id}"
                         f" --values Diana,28,Chicago")
    print(f"Appended: {(await r.stdout_str())[:80]}")

    print("\n=== gws-sheets-read (all) ===")
    r = await ws.execute(f'gws-sheets-read'
                         f' --spreadsheet {sheet_id}'
                         f' --range Sheet1')
    print(f"All: {await r.stdout_str()}")

    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}"
    print(f"\nOpen: {url}")


if __name__ == "__main__":
    asyncio.run(main())

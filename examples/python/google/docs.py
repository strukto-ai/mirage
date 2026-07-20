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
from mirage.resource.gdocs import GDocsConfig, GDocsResource

load_dotenv(".env.development")

config = GDocsConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GDocsResource(config=config)


async def main():
    ws = Workspace({"/gdocs": resource}, mode=MountMode.WRITE)

    r = await ws.execute("ls /gdocs/owned/ | head -n 3")
    print("=== ls (first 3) ===")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== plan: cat ===")
    dr = await ws.execute(f"cat /gdocs/owned/{first}", provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== plan: grep ===")
    dr = await ws.execute(f"grep textRun /gdocs/owned/{first}", provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== jq .title ===")
    r = await ws.execute(f'jq ".title" /gdocs/owned/{first}')
    print(await r.stdout_str())

    print("=== head -c 200 ===")
    r = await ws.execute(f"head -c 200 /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== grep textRun ===")
    r = await ws.execute(f"grep textRun /gdocs/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("=== tail -c 200 ===")
    r = await ws.execute(f"tail -c 200 /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== gws docs documents create ===")
    r = await ws.execute('gws docs documents create'
                         ' --json \'{"title": "MIRAGE Example Doc"}\'')
    doc = json.loads(await r.stdout_str())
    doc_id = doc["documentId"]
    print(f"Created: {doc_id}")

    print("\n=== gws docs documents batchUpdate ===")
    body = json.dumps({
        "requests": [{
            "insertText": {
                "location": {
                    "index": 1
                },
                "text": "Hello from MIRAGE!\n",
            }
        }]
    })
    params = json.dumps({"documentId": doc_id})
    r = await ws.execute(f"gws docs documents batchUpdate"
                         f" --params '{params}' --json '{body}'")
    print(f"Updated: {(await r.stdout_str())[:80]}")

    print("\n=== gws docs +write ===")
    r = await ws.execute(f'gws docs +write'
                         f' --document {doc_id}'
                         f' --text "Appended via gws docs +write."')
    print(f"Written: {(await r.stdout_str())[:80]}")

    url = f"https://docs.google.com/document/d/{doc_id}/edit"
    print(f"\nOpen: {url}")


if __name__ == "__main__":
    asyncio.run(main())

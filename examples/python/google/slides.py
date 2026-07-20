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
from mirage.resource.gslides import GSlidesConfig, GSlidesResource

load_dotenv(".env.development")

config = GSlidesConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GSlidesResource(config=config)


async def main():
    ws = Workspace({"/gslides": resource}, mode=MountMode.WRITE)

    r = await ws.execute("ls /gslides/owned/ | head -n 3")
    print("=== ls (first 3) ===")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== plan: cat ===")
    dr = await ws.execute(f"cat /gslides/owned/{first}", provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== plan: grep ===")
    dr = await ws.execute(f"grep textRun /gslides/owned/{first}",
                          provision=True)
    print(f"  network_read={dr.network_read}, precision={dr.precision}")

    print("=== jq .title ===")
    r = await ws.execute(f'jq ".title" /gslides/owned/{first}')
    print(await r.stdout_str())

    print('=== jq ".slides | length" ===')
    r = await ws.execute(f'jq ".slides | length" /gslides/owned/{first}')
    print(await r.stdout_str())

    print("=== head -c 200 ===")
    r = await ws.execute(f"head -c 200 /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== grep textRun ===")
    r = await ws.execute(f"grep textRun /gslides/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("=== tail -c 200 ===")
    r = await ws.execute(f"tail -c 200 /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== gws slides presentations create ===")
    r = await ws.execute('gws slides presentations create'
                         ' --json \'{"title": "MIRAGE Slides Test"}\'')
    pres = json.loads(await r.stdout_str())
    pres_id = pres["presentationId"]
    print(f"Created: {pres_id}")

    print("\n=== gws slides presentations batchUpdate ===")
    body = json.dumps({
        "requests": [{
            "createSlide": {
                "insertionIndex": 1,
                "slideLayoutReference": {
                    "predefinedLayout": "BLANK"
                },
            }
        }]
    })
    params = json.dumps({"presentationId": pres_id})
    r = await ws.execute("gws slides presentations batchUpdate"
                         f" --params '{params}' --json '{body}'")
    update = json.loads(await r.stdout_str())
    slide_id = update["replies"][0]["createSlide"]["objectId"]
    print(f"Added slide: {slide_id}")

    url = (f"https://docs.google.com/presentation/"
           f"d/{pres_id}/edit")
    print(f"\nOpen: {url}")


if __name__ == "__main__":
    asyncio.run(main())

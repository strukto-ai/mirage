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
from mirage.types import PathSpec

load_dotenv(".env.development")

config = GSlidesConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GSlidesResource(config=config)


async def main() -> None:
    ws = Workspace({"/gslides": resource}, mode=MountMode.WRITE)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /gslides/__nf_missing__.txt",
                "head /gslides/__nf_missing__.txt",
                "stat /gslides/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /gslides/ ===")
    r = await ws.execute("ls /gslides/")
    print(await r.stdout_str())

    print("=== ls /gslides/owned/ (first 5) ===")
    r = await ws.execute("ls /gslides/owned/ | head -n 5")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== cat ===")
    r = await ws.execute(f"cat /gslides/owned/{first}")
    print((await r.stdout_str())[:300])

    print("\n=== head -n 20 ===")
    r = await ws.execute(f"head -n 20 /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== tail -n 10 ===")
    r = await ws.execute(f"tail -n 10 /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== wc ===")
    r = await ws.execute(f"wc /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== stat ===")
    r = await ws.execute(f"stat /gslides/owned/{first}")
    print(await r.stdout_str())

    # chmod/chown/touch never hit the Slides API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on /gslides/owned/{first} ===")
    r = await ws.execute(f'chmod 640 "/gslides/owned/{first}"'
                         f' && chown 500:dev "/gslides/owned/{first}"'
                         f' && touch -t 202601021530 "/gslides/owned/{first}"')
    print(f"  chmod/chown/touch exit={r.exit_code}")
    st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path(f"/gslides/owned/{first}"))
    print(f"  dispatch stat: mode={oct(st.mode)[2:]} uid={st.uid} "
          f"gid={st.gid} mtime={st.modified}")

    print("=== jq .title ===")
    r = await ws.execute(f'jq ".title" /gslides/owned/{first}')
    print(await r.stdout_str())

    print('=== jq ".slides | length" ===')
    r = await ws.execute(f'jq ".slides | length" /gslides/owned/{first}')
    print(await r.stdout_str())

    print("=== nl ===")
    r = await ws.execute(f"nl /gslides/owned/{first} | head -n 10")
    print(await r.stdout_str())

    print("=== tree /gslides/ ===")
    r = await ws.execute("tree /gslides/")
    print((await r.stdout_str())[:500])

    print("\n=== find /gslides/owned/ ===")
    r = await ws.execute(
        "find /gslides/owned/ -name '*.gslide.json' | head -n 5")
    print(await r.stdout_str())

    print("=== grep textRun ===")
    r = await ws.execute(f"grep textRun /gslides/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("\n=== rg textRun ===")
    r = await ws.execute(f"rg textRun /gslides/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("\n=== basename ===")
    r = await ws.execute(f"basename /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== dirname ===")
    r = await ws.execute(f"dirname /gslides/owned/{first}")
    print(await r.stdout_str())

    print("=== realpath ===")
    r = await ws.execute(f"realpath /gslides/owned/{first}")
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

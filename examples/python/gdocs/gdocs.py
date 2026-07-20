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
from mirage.types import PathSpec

load_dotenv(".env.development")

config = GDocsConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GDocsResource(config=config)


async def main() -> None:
    ws = Workspace({"/gdocs": resource}, mode=MountMode.WRITE)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /gdocs/__nf_missing__.txt",
                "head /gdocs/__nf_missing__.txt",
                "stat /gdocs/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /gdocs/ ===")
    r = await ws.execute("ls /gdocs/")
    print(await r.stdout_str())

    print("=== ls /gdocs/owned/ (first 5) ===")
    r = await ws.execute("ls /gdocs/owned/ | head -n 5")
    print(await r.stdout_str())

    first = (await r.stdout_str()).strip().split("\n")[0]

    print("=== cat ===")
    r = await ws.execute(f"cat /gdocs/owned/{first}")
    print((await r.stdout_str())[:300])

    print("\n=== head -n 20 ===")
    r = await ws.execute(f"head -n 20 /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== tail -n 10 ===")
    r = await ws.execute(f"tail -n 10 /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== wc ===")
    r = await ws.execute(f"wc /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== stat ===")
    r = await ws.execute(f"stat /gdocs/owned/{first}")
    print(await r.stdout_str())

    # chmod/chown/touch never hit the Docs API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on /gdocs/owned/{first} ===")
    r = await ws.execute(f'chmod 640 "/gdocs/owned/{first}"'
                         f' && chown 500:dev "/gdocs/owned/{first}"'
                         f' && touch -t 202601021530 "/gdocs/owned/{first}"')
    print(f"  chmod/chown/touch exit={r.exit_code}")
    st, _ = await ws.dispatch("stat",
                              PathSpec.from_str_path(f"/gdocs/owned/{first}"))
    print(f"  dispatch stat: mode={oct(st.mode)[2:]} uid={st.uid} "
          f"gid={st.gid} mtime={st.modified}")

    print("=== jq .title ===")
    r = await ws.execute(f'jq ".title" /gdocs/owned/{first}')
    print(await r.stdout_str())

    print("=== nl ===")
    r = await ws.execute(f"nl /gdocs/owned/{first} | head -n 10")
    print(await r.stdout_str())

    print("=== tree /gdocs/ ===")
    r = await ws.execute("tree /gdocs/")
    print((await r.stdout_str())[:500])

    print("\n=== find /gdocs/owned/ ===")
    r = await ws.execute("find /gdocs/owned/ -name '*.gdoc.json' | head -n 5")
    print(await r.stdout_str())

    print("=== grep textRun ===")
    r = await ws.execute(f"grep textRun /gdocs/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("\n=== rg textRun ===")
    r = await ws.execute(f"rg textRun /gdocs/owned/{first} | head -c 200")
    print(await r.stdout_str())

    print("\n=== basename ===")
    r = await ws.execute(f"basename /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== dirname ===")
    r = await ws.execute(f"dirname /gdocs/owned/{first}")
    print(await r.stdout_str())

    print("=== realpath ===")
    r = await ws.execute(f"realpath /gdocs/owned/{first}")
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

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
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS

load_dotenv(".env.development")

config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
vfs = GoogleDriveVFS(config=config)


async def main():
    ws = Workspace({"/gdrive": vfs}, mode=MountMode.READ)

    print("=== ls /gdrive/ (first 10) ===")
    r = await ws.shell("ls /gdrive/ | head -n 10")
    print(await r.stdout_str())

    r = await ws.shell("ls /gdrive/ | head -n 30")
    listing = await r.stdout_str()
    gdoc = gsheet = gslide = None
    for line in listing.strip().split("\n"):
        f = line.strip()
        if ".gdoc.json" in f and not gdoc:
            gdoc = f
        if ".gsheet.json" in f and not gsheet:
            gsheet = f
        if ".gslide.json" in f and not gslide:
            gslide = f

    if gdoc:
        print(f"=== jq .title on {gdoc} ===")
        r = await ws.shell(f'jq ".title" "/gdrive/{gdoc}"')
        print(await r.stdout_str())

        print(f"=== head -c 150 on {gdoc} ===")
        r = await ws.shell(f'head -c 150 "/gdrive/{gdoc}"')
        print(await r.stdout_str())

    if gslide:
        print(f"\n=== jq .title on {gslide} ===")
        r = await ws.shell(f'jq ".title" "/gdrive/{gslide}"')
        print(await r.stdout_str())

        print("=== jq slides length ===")
        r = await ws.shell(f'jq ".slides | length" "/gdrive/{gslide}"')
        print(await r.stdout_str())

    if gsheet:
        print(f"\n=== jq .properties.title on {gsheet} ===")
        r = await ws.shell(f'jq ".properties.title" "/gdrive/{gsheet}"')
        print(await r.stdout_str())


if __name__ == "__main__":
    asyncio.run(main())

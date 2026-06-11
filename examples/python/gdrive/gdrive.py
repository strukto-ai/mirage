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
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource

load_dotenv(".env.development")

config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
resource = GoogleDriveResource(config=config)


async def main() -> None:
    ws = Workspace({"/gdrive": resource}, mode=MountMode.WRITE)

    print("=== ls /gdrive/ ===")
    result = await ws.execute("ls /gdrive/")
    print(await result.stdout_str())

    entries = (await result.stdout_str()).strip().splitlines()
    if not entries:
        print("No files")
        return
    first = entries[0]

    print(f"=== stat /gdrive/{first} ===")
    result = await ws.execute(f'stat "/gdrive/{first}"')
    print(await result.stdout_str())

    if first.endswith("/"):
        print(f"=== ls /gdrive/{first} ===")
        result = await ws.execute(f'ls "/gdrive/{first}"')
        print(await result.stdout_str())
        sub_entries = (await result.stdout_str()).strip().splitlines()
        if sub_entries:
            sub = sub_entries[0]
            if not sub.endswith("/"):
                print(f"=== cat /gdrive/{first}{sub} ===")
                result = await ws.execute(f'cat "/gdrive/{first}{sub}"')
                print((await result.stdout_str())[:500])

    print("=== tree -L 1 /gdrive/ ===")
    result = await ws.execute("tree -L 1 /gdrive/")
    print(await result.stdout_str())

    print("=== find /gdrive/ -name '*.gdoc.json' | head -n 5 ===")
    result = await ws.execute("find /gdrive/ -name '*.gdoc.json' | head -n 5")
    print(await result.stdout_str())

    gdoc_files = (await result.stdout_str()).strip().splitlines()
    if gdoc_files:
        gdoc = gdoc_files[0]
        print(f"=== cat {gdoc} | jq .title ===")
        result = await ws.execute(f'cat "{gdoc}" | jq ".title"')
        print(await result.stdout_str())

        print(f"=== head -n 3 {gdoc} ===")
        result = await ws.execute(f'head -n 3 "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== wc {gdoc} ===")
        result = await ws.execute(f'wc "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== basename {gdoc} ===")
        result = await ws.execute(f'basename "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== dirname {gdoc} ===")
        result = await ws.execute(f'dirname "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== tail -n 3 {gdoc} ===")
        result = await ws.execute(f'tail -n 3 "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== nl {gdoc} ===")
        result = await ws.execute(f'nl "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== grep title {gdoc} ===")
        result = await ws.execute(f'grep title "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== rg title {gdoc} ===")
        result = await ws.execute(f'rg title "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== cut -c 1-40 {gdoc} ===")
        result = await ws.execute(f'cut -c 1-40 "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== sed -n 2p {gdoc} ===")
        result = await ws.execute(f'sed -n 2p "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== sed s/title/TITLE/g {gdoc} ===")
        result = await ws.execute(f'sed "s/title/TITLE/g" "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== realpath {gdoc} ===")
        result = await ws.execute(f'realpath "{gdoc}"')
        print(await result.stdout_str())

    print("=== gws-docs-documents-create ===")
    result = await ws.execute(
        'gws-docs-documents-create'
        ' --json \'{"title": "Test from MIRAGE gdrive"}\'')
    print((await result.stdout_str())[:300])

    print("=== gws-sheets-spreadsheets-create ===")
    result = await ws.execute(
        'gws-sheets-spreadsheets-create'
        ' --json \'{"properties": {"title": "Test Sheet from gdrive"}}\'')
    print((await result.stdout_str())[:300])


if __name__ == "__main__":
    asyncio.run(main())

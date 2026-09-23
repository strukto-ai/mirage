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
from mirage.commands.cli.builtin.gws import GWS
from mirage.types import PathSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS

load_dotenv(".env.development")

config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)
vfs = GoogleDriveVFS(config=config)


async def main() -> None:
    ws = Workspace({"/gdrive": vfs}, mode=MountMode.WRITE)
    # The gws verbs are a CLI install, separate from the mounts.
    ws.register_cli("gws", GWS, config.model_dump())

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /gdrive/__nf_missing__.txt",
                "head /gdrive/__nf_missing__.txt",
                "stat /gdrive/__nf_missing__.txt"):
        result = await ws.shell(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /gdrive/ ===")
    result = await ws.shell("ls /gdrive/")
    print(await result.stdout_str())

    entries = (await result.stdout_str()).strip().splitlines()
    if not entries:
        print("No files")
        return
    first = entries[0]

    print(f"=== stat /gdrive/{first} ===")
    result = await ws.shell(f'stat "/gdrive/{first}"')
    print(await result.stdout_str())

    # chmod/chown/touch never hit the Drive API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on /gdrive/{first} ===")
    result = await ws.shell(f'chmod 640 "/gdrive/{first}" && chown 500:dev'
                            f' "/gdrive/{first}"'
                            f' && touch -t 202601021530 "/gdrive/{first}"')
    print(f"  chmod/chown/touch exit={result.exit_code}")
    st, _ = await ws.dispatch("stat",
                              PathSpec.from_str_path(f"/gdrive/{first}"))
    print(f"  dispatch stat: mode={oct(st.mode)[2:]} uid={st.uid} "
          f"gid={st.gid} mtime={st.modified}")

    if first.endswith("/"):
        print(f"=== ls /gdrive/{first} ===")
        result = await ws.shell(f'ls "/gdrive/{first}"')
        print(await result.stdout_str())
        sub_entries = (await result.stdout_str()).strip().splitlines()
        if sub_entries:
            sub = sub_entries[0]
            if not sub.endswith("/"):
                print(f"=== cat /gdrive/{first}{sub} ===")
                result = await ws.shell(f'cat "/gdrive/{first}{sub}"')
                print((await result.stdout_str())[:500])

    print("=== tree -L 1 /gdrive/ ===")
    result = await ws.shell("tree -L 1 /gdrive/")
    print(await result.stdout_str())

    print("=== find /gdrive/ -name '*.gdoc.json' | head -n 5 ===")
    result = await ws.shell("find /gdrive/ -name '*.gdoc.json' | head -n 5")
    print(await result.stdout_str())

    gdoc_files = (await result.stdout_str()).strip().splitlines()
    if gdoc_files:
        gdoc = gdoc_files[0]
        print(f"=== cat {gdoc} | jq .title ===")
        result = await ws.shell(f'cat "{gdoc}" | jq ".title"')
        print(await result.stdout_str())

        print(f"=== head -n 3 {gdoc} ===")
        result = await ws.shell(f'head -n 3 "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== wc {gdoc} ===")
        result = await ws.shell(f'wc "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== basename {gdoc} ===")
        result = await ws.shell(f'basename "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== dirname {gdoc} ===")
        result = await ws.shell(f'dirname "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== tail -n 3 {gdoc} ===")
        result = await ws.shell(f'tail -n 3 "{gdoc}"')
        print(await result.stdout_str())

        print(f"=== nl {gdoc} ===")
        result = await ws.shell(f'nl "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== grep title {gdoc} ===")
        result = await ws.shell(f'grep title "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== rg title {gdoc} ===")
        result = await ws.shell(f'rg title "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== cut -c 1-40 {gdoc} ===")
        result = await ws.shell(f'cut -c 1-40 "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== sed -n 2p {gdoc} ===")
        result = await ws.shell(f'sed -n 2p "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== sed s/title/TITLE/g {gdoc} ===")
        result = await ws.shell(f'sed "s/title/TITLE/g" "{gdoc}"')
        print((await result.stdout_str())[:300])

        print(f"=== realpath {gdoc} ===")
        result = await ws.shell(f'realpath "{gdoc}"')
        print(await result.stdout_str())

    print("=== gws docs documents create ===")
    result = await ws.shell('gws docs documents create'
                            ' --json \'{"title": "Test from MIRAGE gdrive"}\'')
    print((await result.stdout_str())[:300])

    print("=== gws sheets spreadsheets create ===")
    result = await ws.shell(
        'gws sheets spreadsheets create'
        ' --json \'{"properties": {"title": "Test Sheet from gdrive"}}\'')
    print((await result.stdout_str())[:300])


if __name__ == "__main__":
    asyncio.run(main())

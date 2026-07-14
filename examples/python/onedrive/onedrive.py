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
from mirage.resource.onedrive import OneDriveConfig, OneDriveResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = OneDriveConfig(
    access_token=os.environ["MS_GRAPH_DRIVE_TOKEN"],
    drive_id=os.environ.get("MS_GRAPH_DRIVE_ID") or None,
)
backend = OneDriveResource(config)
ws = Workspace({"/onedrive/": backend}, mode=MountMode.WRITE)

TEST_FILE = "/onedrive/mirage_onedrive_example.txt"


async def main() -> None:
    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /onedrive/__nf_missing__.txt",
                "head /onedrive/__nf_missing__.txt",
                "stat /onedrive/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== ls /onedrive/ (top level) ===")
    print((await (await ws.execute("ls /onedrive/")).stdout_str())
          or "(empty)")

    print(f"\n=== write {TEST_FILE} ===")
    await ws.execute(f"echo 'hello from mirage onedrive' > {TEST_FILE}")

    print("=== cat it back ===")
    print(await (await ws.execute(f"cat {TEST_FILE}")).stdout_str())

    print("=== sed read-transform: cat | sed 's/hello/HELLO/' ===")
    print(await
          (await
           ws.execute(f"cat {TEST_FILE} | sed 's/hello/HELLO/'")).stdout_str())

    print("=== stat (fingerprint = cTag) ===")
    print(await (await ws.execute(f"stat {TEST_FILE}")).stdout_str())

    # chmod/chown/touch never hit the Graph API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {TEST_FILE} ===")
    meta_res = await ws.execute(f'chmod 640 "{TEST_FILE}"'
                                f' && chown 500:dev "{TEST_FILE}"'
                                f' && touch -t 202601021530 "{TEST_FILE}"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path(f"{TEST_FILE}"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    print("=== overwrite (creates a new version) ===")
    await ws.execute(f"echo 'second version' > {TEST_FILE}")
    print(await (await ws.execute(f"cat {TEST_FILE}")).stdout_str())

    print("=== version history ===")
    from mirage.core.onedrive.versions import list_versions
    versions = await list_versions(backend.accessor,
                                   PathSpec.from_str_path(TEST_FILE))
    for v in versions:
        print(f"  version {v.get('id')}  size={v.get('size')}  "
              f"modified={v.get('lastModifiedDateTime')}")

    print("\n=== cleanup ===")
    await ws.execute(f"rm {TEST_FILE}")
    print("done")


asyncio.run(main())

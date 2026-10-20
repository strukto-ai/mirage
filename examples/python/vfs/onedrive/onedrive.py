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
import uuid

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.core.msgraph.client import graph_list
from mirage.core.onedrive.client import drive_loc
from mirage.types import PathSpec
from mirage.vfs.onedrive import OneDriveConfig, OneDriveVFS

load_dotenv(".env.development")

config = OneDriveConfig(
    access_token=os.environ["MS_GRAPH_DRIVE_TOKEN"],
    drive_id=os.environ.get("MS_GRAPH_DRIVE_ID") or None,
)
backend = OneDriveVFS(config)
ws = Workspace({"/onedrive/": backend}, mode=MountMode.WRITE)

TEST_KEY = f"mirage_onedrive_example-{uuid.uuid4().hex[:8]}.txt"
TEST_FILE = f"/onedrive/{TEST_KEY}"


async def create_test_file() -> None:
    """Write this run's scratch file, refusing to replace one already there.

    The name is unique per run, so cleanup can delete it knowing nothing
    else was stored under it.
    """
    if (await ws.shell(f"stat {TEST_FILE}")).exit_code == 0:
        raise RuntimeError(f"{TEST_FILE} already exists, not touching it")
    r = await ws.shell(f"echo 'hello from mirage onedrive' > {TEST_FILE}")
    if r.exit_code != 0:
        err = (await r.stderr_str()).strip()
        raise RuntimeError(f"write {TEST_FILE} failed: {err}")


async def exercise() -> None:
    print("=== cat it back ===")
    print(await (await ws.shell(f"cat {TEST_FILE}")).stdout_str())

    print("=== sed read-transform: cat | sed 's/hello/HELLO/' ===")
    print(
        await (
            await ws.shell(f"cat {TEST_FILE} | sed 's/hello/HELLO/'")
        ).stdout_str()
    )

    print("=== stat (fingerprint = cTag) ===")
    print(await (await ws.shell(f"stat {TEST_FILE}")).stdout_str())

    # chmod/chown/touch never hit the Graph API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {TEST_FILE} ===")
    meta_res = await ws.shell(
        f'chmod 640 "{TEST_FILE}"'
        f' && chown 500:dev "{TEST_FILE}"'
        f' && touch -t 202601021530 "{TEST_FILE}"'
    )
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path(f"{TEST_FILE}")
    )
    meta_mode = oct(meta_st.mode)[2:] if meta_st.mode is not None else "-"
    print(
        f"  dispatch stat: mode={meta_mode} uid={meta_st.uid} "
        f"gid={meta_st.gid} mtime={meta_st.modified}"
    )

    print("=== overwrite (creates a new version) ===")
    await ws.shell(f"echo 'second version' > {TEST_FILE}")
    print(await (await ws.shell(f"cat {TEST_FILE}")).stdout_str())

    print("=== version history ===")
    versions = await graph_list(
        backend.accessor,
        drive_loc(backend.accessor.config, TEST_KEY).item("/versions"),
    )
    for v in versions:
        print(
            f"  version {v.get('id')}  size={v.get('size')}  "
            f"modified={v.get('lastModifiedDateTime')}"
        )


async def main() -> None:
    try:
        print("=== not-found errors show the full virtual path ===")
        for cmd in (
            "cat /onedrive/__nf_missing__.txt",
            "head /onedrive/__nf_missing__.txt",
            "stat /onedrive/__nf_missing__.txt",
        ):
            result = await ws.shell(cmd)
            print(f"$ {cmd}")
            print(
                f"  exit={result.exit_code}"
                f"  {(await result.stderr_str()).strip()}"
            )

        print("=== ls /onedrive/ (top level) ===")
        print(
            (await (await ws.shell("ls /onedrive/")).stdout_str()) or "(empty)"
        )

        print(f"\n=== write {TEST_FILE} ===")
        await create_test_file()
        try:
            await exercise()
        finally:
            print("\n=== cleanup ===")
            r = await ws.shell(f"rm {TEST_FILE}")
            if r.exit_code != 0:
                err = (await r.stderr_str()).strip()
                print(f"  rm {TEST_FILE} failed: {err}")
        print("done")
    finally:
        await ws.close()


asyncio.run(main())

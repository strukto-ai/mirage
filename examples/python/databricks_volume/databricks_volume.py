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
from mirage.resource.databricks_volume import (DatabricksVolumeConfig,
                                               DatabricksVolumeResource)
from mirage.types import PathSpec

load_dotenv(".env.development")

config = DatabricksVolumeConfig(
    catalog=os.environ["DATABRICKS_VOLUME_CATALOG"],
    schema=os.environ["DATABRICKS_VOLUME_SCHEMA"],
    volume=os.environ["DATABRICKS_VOLUME_NAME"],
    root_path=os.environ.get("DATABRICKS_VOLUME_ROOT_PATH", "/"),
    host=os.environ.get("DATABRICKS_HOST"),
    token=os.environ.get("DATABRICKS_TOKEN"),
    profile=os.environ.get("DATABRICKS_CONFIG_PROFILE"),
)
resource = DatabricksVolumeResource(config=config)


async def _run(ws, cmd):
    print(f"\n>>> {cmd}")
    result = await ws.execute(cmd)
    stdout = (await result.stdout_str()).strip()
    stderr = (await result.stderr_str()).strip()
    if stdout:
        for line in stdout.splitlines()[:12]:
            print(f"  {line[:140]}")
        if len(stdout.splitlines()) > 12:
            print(f"  ... ({len(stdout.splitlines())} lines total)")
    if stderr:
        print(f"  [stderr] {stderr[:140]}")
    if not stdout and not stderr:
        print(f"  (empty, exit={result.exit_code})")
    return result


async def main():
    ws = Workspace({"/dbx/": resource}, mode=MountMode.READ)

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /dbx/__nf_missing__.txt", "head /dbx/__nf_missing__.txt",
                "stat /dbx/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    await _run(ws, "ls /dbx/")
    await _run(ws, "tree -L 2 /dbx/")
    await _run(ws, 'find /dbx/ -name "*.md"')

    target = os.environ.get("DATABRICKS_VOLUME_SAMPLE_FILE")
    if target:
        await _run(ws, f'stat "{target}"')

        # chmod/chown/touch never hit the Databricks API: attrs land in
        # the workspace namespace and merge into dispatch-level stat.
        print(f"=== metadata overlay on {target} ===")
        meta_res = await ws.execute(f'chmod 640 "{target}"'
                                    f' && chown 500:dev "{target}"'
                                    f' && touch -t 202601021530 "{target}"')
        print(f"  chmod/chown/touch exit={meta_res.exit_code}")
        try:
            meta_st, _ = await ws.dispatch("stat",
                                           PathSpec.from_str_path(target))
            print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} "
                  f"uid={meta_st.uid} gid={meta_st.gid} "
                  f"mtime={meta_st.modified}")
        except FileNotFoundError:
            print("  dispatch stat: target missing in this environment")
        await _run(ws, f'head -n 20 "{target}"')
        await _run(ws, f'grep -n TODO "{target}"')
    else:
        print("\nSet DATABRICKS_VOLUME_SAMPLE_FILE to run file reads.")


if __name__ == "__main__":
    asyncio.run(main())

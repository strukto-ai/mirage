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

from mirage import RAMVFS, MountMode, Workspace

load_dotenv(".env.development")

# Without a sandbox_id Mirage starts a sandbox at the first program and
# deletes it with the workspace. Programs there reach only PyPI.
MACHINE: dict[str, object] = {
    "provider": "kosa8",
    "allowed_domains": ["pypi.org", "files.pythonhosted.org"],
    "captures": ["@python", "@external"],
}
if sandbox_id := os.environ.get("KOSA8_SANDBOX_ID"):
    MACHINE["sandbox_id"] = sandbox_id
else:
    # kosa8's base template is Alpine without Python; boot an image with it.
    MACHINE["image"] = "python:3.12-slim"

TOTAL_PY = (
    "import csv, json, sys\n"
    "rows = list(csv.DictReader(sys.stdin))\n"
    "total = sum(float(r['value']) for r in rows)\n"
    "print(json.dumps({'rows': len(rows), 'total': total}))\n"
)

POINTS_CSV = "name,value\nalpha,1.5\nbeta,2.5\ngamma,4.0\n"


async def show(ws: Workspace, command: str) -> None:
    result = await ws.shell(command)
    print(f"$ {command}")
    stdout = await result.stdout_str()
    if stdout:
        print(stdout, end="" if stdout.endswith("\n") else "\n")
    if result.exit_code != 0:
        stderr = (await result.stderr_str()).strip().splitlines()
        print(f"  exit {result.exit_code}: {stderr[-1] if stderr else ''}")


async def main() -> None:
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"sandbox": MACHINE},
    )
    try:
        await ws.shell("cat > /data/points.csv", stdin=POINTS_CSV.encode())

        # python3 runs in the kosa8 sandbox.
        await show(ws, "python3 -c 'import platform; print(platform.node())'")

        # The workspace file goes in on stdin; the answer lands back in
        # the workspace.
        await show(
            ws,
            f'cat /data/points.csv | python3 -c "{TOTAL_PY}" > /data/out.json',
        )
        await show(ws, "cat /data/out.json")

        # The sandbox keeps its disk and processes between lines.
        await show(ws, 'python3 -c \'open("/tmp/seen", "w").write("1")\'')
        await show(ws, "python3 -c 'print(open(\"/tmp/seen\").read())'")

        # Only the allowed hosts answer.
        await show(
            ws,
            "python3 -c 'import urllib.request as u; "
            'print(u.urlopen("https://pypi.org/simple/", timeout=10).status)\'',
        )
        await show(
            ws,
            "python3 -c 'import urllib.request as u; "
            'u.urlopen("https://example.com", timeout=10)\'',
        )
    finally:
        # Deleting the workspace deletes the sandbox Mirage started; a
        # sandbox you brought stays.
        if "sandbox_id" in MACHINE:
            await ws.close()
        else:
            await ws.delete()


if __name__ == "__main__":
    asyncio.run(main())

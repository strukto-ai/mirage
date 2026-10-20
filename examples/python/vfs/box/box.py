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
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.types import PathSpec
from mirage.vfs.box import BoxConfig, BoxVFS

load_dotenv(".env.development")


def build_config() -> BoxConfig:
    dev_token = os.environ.get("BOX_DEVELOPER_TOKEN") or os.environ.get(
        "BOX_ACCESS_TOKEN"
    )
    if dev_token:
        return BoxConfig(access_token=dev_token)
    client_id = os.environ.get("BOX_CLIENT_ID")
    client_secret = os.environ.get("BOX_CLIENT_SECRET")
    enterprise_id = os.environ.get("BOX_ENTERPRISE_ID")
    if client_id and client_secret and enterprise_id:
        return BoxConfig(
            client_id=client_id,
            client_secret=client_secret,
            enterprise_id=enterprise_id,
        )
    refresh_token = os.environ.get("BOX_REFRESH_TOKEN")
    if not (client_id and client_secret and refresh_token):
        raise RuntimeError(
            "Provide BOX_DEVELOPER_TOKEN, or BOX_CLIENT_ID + "
            "BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID (service account), or "
            "BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN"
        )
    return BoxConfig(
        client_id=client_id,
        client_secret=client_secret,
        refresh_token=refresh_token,
    )


async def show(ws: Workspace, cmd: str, max_chars: int = 600) -> str:
    print(f"=== {cmd} ===")
    try:
        result = await ws.shell(cmd)
        out = await result.stdout_str()
        if out:
            print(out[:max_chars] + ("..." if len(out) > max_chars else ""))
        err = (await result.stderr_str()).strip()
        if err:
            print(f"  STDERR: {err[:200]}", file=sys.stderr)
        return out
    except Exception as exc:
        print(f"  ERROR: {exc}", file=sys.stderr)
        return ""


def quote(path: str) -> str:
    return f'"{path}"'


async def main() -> None:
    vfs = BoxVFS(build_config())
    ws = Workspace({"/box": vfs}, mode=MountMode.READ)
    try:
        print("=== not-found errors show the full virtual path ===")
        for cmd in (
            "cat /box/__nf_missing__.txt",
            "head /box/__nf_missing__.txt",
            "stat /box/__nf_missing__.txt",
        ):
            result = await ws.shell(cmd)
            print(f"$ {cmd}")
            print(
                f"  exit={result.exit_code}  "
                f"{(await result.stderr_str()).strip()}"
            )

        await show(ws, "ls /box/")
        await show(ws, "tree -L 2 /box/", 1200)
        await show(ws, "du -h /box/")

        found = await show(ws, "find /box -type f -maxdepth 3", 1200)
        files = [p for p in found.strip().split("\n") if p]
        if not files:
            print(
                "No files found under /box/, upload something to exercise "
                "read commands."
            )
            return
        f1 = quote(files[0])
        f2 = quote(files[1] if len(files) > 1 else files[0])

        await show(ws, f"stat {f1}")

        # chmod/chown/touch never hit the Box API: attrs land in the
        # workspace namespace (durable, snapshot-captured) and merge into
        # dispatch-level stat.
        print(f"=== metadata overlay on {files[0]} ===")
        meta_res = await ws.shell(
            f"chmod 640 {f1} && chown 500:dev {f1}"
            f" && touch -t 202601021530 {f1}"
        )
        print(f"  chmod/chown/touch exit={meta_res.exit_code}")
        meta_st, _ = await ws.dispatch(
            "stat", PathSpec.from_str_path(files[0])
        )
        meta_mode = oct(meta_st.mode)[2:] if meta_st.mode is not None else "-"
        print(
            f"  dispatch stat: mode={meta_mode} uid={meta_st.uid} "
            f"gid={meta_st.gid} mtime={meta_st.modified}"
        )
        await show(ws, f"file {f1}")
        await show(ws, f"head -n 5 {f1}")
        await show(ws, f"tail -n 3 {f1}")
        await show(ws, f"nl {f1} | head -n 5")
        await show(ws, f"wc {f1} {f2}")
        await show(ws, f"cat {f1} {f2} | wc -c")
        await show(ws, f"sort {f1} | head -n 3")
        await show(ws, f"uniq {f1} | wc -l")
        await show(ws, f"cut -c 1-40 {f1} | head -n 3")
        await show(ws, f"sed -n 1,2p {f1}")
        await show(ws, f"cat {f1} | sed 's/[0-9]/#/g' | head -n 3")
        # -i is rejected on the read-only Box mount (sed is read-transform
        # here)
        await show(ws, f"sed -i s/x/y/ {f1}")
        await show(ws, f'grep -c "." {f1}')
        await show(ws, 'grep -rl "a" /box/ | head -n 5', 400)
        await show(ws, 'rg -l "a" /box/ | head -n 5', 400)
        await show(
            ws, 'find /box -type f -name "*.json" -maxdepth 3 | head -n 5'
        )
        await show(ws, "du -a /box/ | head -n 8")

        json_file = next((p for p in files if p.endswith(".json")), None)
        if json_file is not None:
            await show(
                ws, f'jq -r "keys | .[]" {quote(json_file)} | head -n 5'
            )
        # Box Notes come back as raw ProseMirror JSON, so jq works directly.
        note = next((p for p in files if p.endswith(".boxnote")), None)
        if note is not None:
            await show(ws, f'jq -r ".doc.content | length" {quote(note)}')
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

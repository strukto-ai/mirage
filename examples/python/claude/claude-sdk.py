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
"""
Example: Use the Claude Agent SDK with a Mirage FUSE-backed workspace.

The agent reads, writes, and edits files — all intercepted by Mirage's
FUSE layer.  Every file operation is recorded and can be inspected after
the agent finishes.

Usage:
    pip install claude-agent-sdk
    python examples/claude/claude-sdk.py
    python examples/claude/claude-sdk.py \
        --prompt "create a python calculator module with tests"
"""

import argparse
import subprocess
import sys
import tempfile

import anyio
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

from mirage.fuse.fs import MirageFS
from mirage.fuse.mount import mount_background
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def unmount(mountpoint: str) -> None:
    if sys.platform == "darwin":
        subprocess.run(["diskutil", "unmount", "force", mountpoint],
                       capture_output=True)
    else:
        subprocess.run(["fusermount", "-u", mountpoint], capture_output=True)


def print_workspace(ws: Workspace, prefix: str = "/") -> None:
    for path in ws.ls(prefix):
        try:
            content = ws.cat(path)
            print(f"\n--- {path} ({len(content)} bytes) ---")
            print(content.decode(errors="replace"))
        except (IsADirectoryError, ValueError):
            print(f"\n--- {path}/ (directory) ---")


def print_ops(ops: list[dict]) -> None:
    for op in ops:
        ts = op["timestamp"]
        print(f"  [{ts}] {op['op']:6s}  {op['path']}")


async def run_agent(mountpoint: str, prompt: str) -> None:
    options = ClaudeAgentOptions(
        cwd=mountpoint,
        allowed_tools=["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        permission_mode="bypassPermissions",
        allow_dangerously_skip_permissions=True,
    )
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            print(f"\n=== Agent result ===\n{message.result}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--prompt",
        default=(
            "Create a file called /hello.py that prints 'Hello from Mirage!' "
            "and a file called /utils.py with a function"
            " that reverses a string."),
    )
    args = parser.parse_args()

    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)

    with tempfile.TemporaryDirectory() as mountpoint:
        fs = MirageFS(ws.ops)
        t = mount_background(ws, mountpoint)
        print(f"Mounted memory workspace at {mountpoint}")
        print(f"Prompt: {args.prompt}\n")

        try:
            anyio.run(run_agent, mountpoint, args.prompt)
        finally:
            ops = fs.drain_ops()
            unmount(mountpoint)
            t.join(timeout=3)

    print("\n=== FUSE operations captured ===")
    if ops:
        print_ops(ops)
    else:
        print("  (no operations recorded)")

    print("\n=== Files in workspace (all in-memory) ===")
    try:
        print_workspace(ws)
    except FileNotFoundError:
        print("  (workspace is empty)")


if __name__ == "__main__":
    main()

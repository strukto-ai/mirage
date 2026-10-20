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
from mirage.vfs.ssh import SSHVFS, SSHConfig

load_dotenv(".env.development")

MOUNT = "/ssh"

config = SSHConfig(
    host=os.environ["SSH_HOST"],
    username=os.environ["SSH_USER"],
    identity_file=os.environ.get("SSH_KEY") or None,
    password=os.environ.get("SSH_PASSWORD"),
    passphrase=os.environ.get("SSH_PASSPHRASE"),
    port=int(os.environ["SSH_PORT"]) if os.environ.get("SSH_PORT") else None,
    root=os.environ.get("SSH_ROOT") or "/",
)
vfs = SSHVFS(config)


async def main() -> None:
    with Workspace({MOUNT: vfs}, mode=MountMode.WRITE) as ws:
        print(f"=== VFS MODE: mounted at {MOUNT} (in-process os patch) ===\n")

        print(f"--- os.listdir() {MOUNT} ---")
        for entry in os.listdir(MOUNT):
            print(f"  {entry}")

        probe = f"{MOUNT}/etc/hostname"
        print(f"\n--- os.stat() {probe} ---")
        try:
            st = os.stat(probe)
            print(f"  size={st.st_size}")
            with open(probe) as f:
                data = f.read()
            print(f"\n--- open() + read {probe} ---")
            print(f"  {data.strip()[:200]}")
        except OSError as exc:
            print(f"  (skipped: {exc})")

        records = ws.vfs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


if __name__ == "__main__":
    asyncio.run(main())

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

# The microVM guest has no /dev/fuse, so Mirage FUSE-mounts S3 on the HOST and
# Microsandbox bind-mounts that path in over virtio-fs. The guest reads it
# natively, with no S3 credentials and no network of its own.
# Requires a running Microsandbox server (`msb server start`), host FUSE
# (Linux fuse3 or macOS macFUSE), and AWS creds in .env.development.

import asyncio
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from microsandbox import Sandbox, Volume

from mirage import MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

REMOTE_DIR = Path(__file__).parent / "remote"


def s3_config() -> S3Config:
    return S3Config(
        bucket=os.environ["AWS_S3_BUCKET"],
        region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
    )


async def main():
    print("=== Mirage FUSE-mounting S3 on the host ===")
    with Workspace(
        {"/s3/": S3Resource(s3_config())},
            mode=MountMode.READ,
            fuse_mounts={"/s3/": True},
    ) as ws:
        time.sleep(1)
        host_s3 = ws.fuse_mountpoints["/s3/"]
        print(f"  host mountpoint: {host_s3}")

        print(
            "\n=== booting microVM (S3 mount bind-mounted in, no network) ===")
        async with await Sandbox.create(
                "mirage-fuse",
                image="python",
                memory=1024,
                cpus=1,
                volumes={
                    "/s3": Volume.bind(host_s3, readonly=True),
                    "/prog": Volume.bind(str(REMOTE_DIR), readonly=True),
                },
                replace=True,
        ) as sandbox:
            result = await sandbox.exec("python", ["/prog/guest.py"])
            print("=== guest output ===")
            print(result.stdout_text.rstrip())
            if result.exit_code != 0:
                print(result.stderr_text, file=sys.stderr)
                print(f"\n=== exit code: {result.exit_code} ===",
                      file=sys.stderr)
                sys.exit(result.exit_code)

        records = ws.ops.records
        total = sum(rec.bytes for rec in records)
        print(
            f"\nMirage served {len(records)} ops, {total} bytes to the sandbox"
        )


if __name__ == "__main__":
    asyncio.run(main())

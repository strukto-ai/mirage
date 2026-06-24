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

# Host prerequisites: the `wasmer` CLI, FUSE (Linux fuse3 or macOS macFUSE),
# and AWS credentials in .env.development. The Python `wasmer` binding is dead
# (no 3.11+ wheels), so we drive the actively-maintained CLI as a subprocess.

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

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


def main():
    wasmer = shutil.which("wasmer")
    if wasmer is None:
        print("wasmer CLI not found on PATH; install from https://wasmer.io",
              file=sys.stderr)
        sys.exit(1)

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
            "\n=== wasmer run python/python (reads /s3 via the mapped dir) ==="
        )
        result = subprocess.run(
            [
                wasmer,
                "run",
                "--mapdir",
                f"/s3:{host_s3}",
                "--mapdir",
                f"/prog:{REMOTE_DIR}",
                "python/python",
                "--",
                "/prog/guest.py",
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )
        print("=== guest output ===")
        print(result.stdout.rstrip())
        if result.returncode != 0:
            print(result.stderr.rstrip(), file=sys.stderr)
            print(f"\n=== exit code: {result.returncode} ===", file=sys.stderr)
            sys.exit(result.returncode)

        records = ws.ops.records
        total = sum(rec.bytes for rec in records)
        print(
            f"\nMirage served {len(records)} ops, {total} bytes to the sandbox"
        )


if __name__ == "__main__":
    main()

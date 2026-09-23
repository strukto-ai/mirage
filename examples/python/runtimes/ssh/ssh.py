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
from mirage.runtime.sandbox.ssh import SSHRuntime
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.ssh import SSHVFS, SSHConfig

# The dataset lives in S3; the compute lives on a machine you can
# already ssh into. The workspace holds both: the bucket at /data and
# the box's own directory at a prefix EQUAL to its remote absolute
# path, so a captured python3 line and the workspace spell that
# directory's files identically (the "Skip the FUSE" recipe). The box
# cannot see /data (mirage mounts live only in the workspace), so the
# data is STAGED: one cp reads S3 and writes over SFTP, and from then
# on the remote interpreter opens a plain local file.
#
# ~/.ssh/config:
#   Host dev
#       HostName ec2-....compute.amazonaws.com
#       IdentityFile ~/.ssh/dev.pem
#       User ubuntu

load_dotenv(".env.development")

REMOTE_DIR = "/home/ubuntu/mirage"

data = S3VFS(
    S3Config(
        bucket=os.environ["AWS_S3_BUCKET"],
        region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        key_prefix="ssh-runtime-demo/",
    ))

proj = SSHVFS(SSHConfig(host="dev", root=REMOTE_DIR, known_hosts=None))

runtime = SSHRuntime(captures=["python3"], config={"host": "dev"})

LOAD_PY = ("import csv, json, sys\n"
           "rows = list(csv.DictReader(open(sys.argv[1])))\n"
           "total = sum(float(r[\"value\"]) for r in rows)\n"
           "out = {\"rows\": len(rows), \"total\": total}\n"
           "json.dump(out, open(\"result.json\", \"w\"))\n"
           "print(\"loaded\", len(rows), \"rows; total\", total)\n")

POINTS_CSV = "name,value\nalpha,1.5\nbeta,2.5\ngamma,4.0\n"


async def show(ws: Workspace, command: str) -> None:
    result = await ws.shell(command, cwd=REMOTE_DIR)
    print(f"$ {command}")
    stdout = await result.stdout_str()
    if stdout:
        print(stdout, end="" if stdout.endswith("\n") else "\n")
    if result.exit_code != 0:
        stderr = await result.stderr_str()
        print(f"  exit {result.exit_code}: {stderr.strip()}")


async def main() -> None:
    ws = Workspace({
        "/data": data,
        REMOTE_DIR: proj
    },
                   mode=MountMode.EXEC,
                   runtimes=[runtime, "workspace"])

    # Seed both sides through the workspace: the dataset into S3, the
    # loader onto the box (an SFTP write; the box provisions itself).
    await ws.shell("cat > /data/points.csv", stdin=POINTS_CSV.encode())
    await ws.shell(f"cat > {REMOTE_DIR}/load.py", stdin=LOAD_PY.encode())
    await show(ws, "ls /data")
    await show(ws, "ls")

    # The boundary, demonstrated: the captured line runs on the box,
    # whose kernel has never heard of the workspace's S3 mount.
    await show(ws, "python3 load.py /data/points.csv")

    # Stage: mirage reads the S3 side and writes the SFTP side.
    await show(ws, "cp /data/points.csv points.csv")

    # Now the operand is a real file beside load.py on the box.
    await show(ws, "python3 load.py points.csv")

    # The result the remote interpreter wrote is already visible
    # through the mount, one path spelling on both sides.
    await show(ws, "cat result.json")

    await show(ws, "rm load.py points.csv result.json /data/points.csv")

    await runtime.close()
    await proj.accessor.close()


if __name__ == "__main__":
    asyncio.run(main())

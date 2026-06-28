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

# Runs inside a Daytona sandbox (uploaded by ../daytona_fuse.py).

import os
import subprocess
import time

from mirage import Mount, MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource

cfg = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

with Workspace(
    {"/s3/": Mount(S3Resource(cfg), fuse=True)},
        mode=MountMode.READ,
) as ws:
    time.sleep(1)
    mp = ws.fuse_mountpoint
    print(f"FUSE mountpoint: {mp}")

    print("\n--- native os.listdir() against FUSE path ---")
    for e in os.listdir(mp):
        print(f"  {e}")

    print("\n--- subprocess sees the same mount ---")
    r = subprocess.run(["ls", mp], capture_output=True, text=True)
    print(r.stdout.rstrip())

    print("\n--- native open() reads through FUSE ---")
    path = f"{mp}/data/example.jsonl"
    size = os.path.getsize(path)
    with open(path) as f:
        head = "".join(next(f) for _ in range(3))
    print(f"  size: {size} bytes")
    print(f"  head:\n{head.rstrip()}")

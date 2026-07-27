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

import os
import subprocess

from dotenv import load_dotenv

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.resource.s3 import S3Config, S3Resource

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)
resource = S3Resource(config)

# S3 is remote but still a byte store: ListObjectsV2 and HeadObject both
# carry ContentLength, so stat() sizes a key without downloading it. That is
# the property FSKit needs, not locality.
with Workspace(
    {"/s3/": Mount(resource, mode=MountMode.READ,
                   backend=MountBackend.FSKIT)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FSKIT MODE: mounted at {mp} ===\n")

    print("--- os.listdir() ---")
    entries = sorted(os.listdir(mp))
    for e in entries[:10]:
        full = f"{mp}/{e}"
        kind = "dir " if os.path.isdir(full) else "file"
        size = 0 if os.path.isdir(full) else os.path.getsize(full)
        print(f"  {kind} {e:30s} {size:>10,} bytes")

    # Sizes come from S3 metadata, so wc -c agrees with stat before any read.
    files = [e for e in entries if not os.path.isdir(f"{mp}/{e}")]
    if files:
        target = f"{mp}/{files[0]}"
        print(f"\n--- stat vs wc -c on {files[0]} ---")
        print(f"  stat : {os.stat(target).st_size} bytes")
        wc = subprocess.run(["wc", "-c", target],
                            capture_output=True,
                            text=True)
        print(f"  wc -c: {wc.stdout.split()[0]} bytes")

    print(f"\n>>> mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls -la {mp}/")
    print(f">>>   grep -r pattern {mp}/")
    print(">>> Press Enter to unmount and exit...")
    input()

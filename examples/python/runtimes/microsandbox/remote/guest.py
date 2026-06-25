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

# Runs inside a Microsandbox microVM (invoked by ../microsandbox_fuse.py).
# /s3 is a host directory that Mirage FUSE-mounted from S3, bind-mounted in
# via virtio-fs. No S3 credentials or network reach this guest.

import os

print("--- os.listdir('/s3') ---")
for entry in sorted(os.listdir("/s3")):
    print(f"  {entry}")

path = "/s3/data/example.jsonl"
print(f"\n--- read {path} through virtio-fs -> FUSE -> Mirage -> S3 ---")
with open(path) as f:
    lines = f.readlines()
hits = sum(1 for line in lines if "mirage" in line)
print(f"  {len(lines)} lines, {hits} containing 'mirage'")
print("  head:")
for line in lines[:3]:
    print(f"    {line.rstrip()}")

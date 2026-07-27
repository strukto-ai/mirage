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
from pathlib import Path

from mirage import Mount, MountMode, Workspace
from mirage.resource.ram import RAMResource

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"

resource = RAMResource()
store = resource._store

for fpath in sorted(DATA_DIR.iterdir()):
    if fpath.is_file():
        key = "/" + fpath.name
        store.files[key] = fpath.read_bytes()
        store.dirs.add("/")

print(f"Loaded {len(store.files)} files from {DATA_DIR}")

# backend="fskit" routes through macFUSE 5.x's FSKit shim: no kernel
# extension is loaded, so this works on a Mac where the kext is blocked.
# RAM is a byte store (SIZES_ALWAYS_KNOWN), which is what makes it eligible:
# FSKit has no direct_io, so it reads exactly as many bytes as stat reports.
with Workspace({
        "/data/":
        Mount(resource, mode=MountMode.WRITE, fuse=True, fuse_backend="fskit")
}) as ws:
    mp = ws.fuse_mountpoint

    print(f"\n=== FSKIT MODE: mounted at {mp} ===\n")

    print("--- os.listdir() ---")
    for e in sorted(os.listdir(mp)):
        size = os.path.getsize(f"{mp}/{e}")
        print(f"  {e:30s} {size:>10,} bytes")

    # The proof that no kernel extension is involved: the mount table tags
    # the volume "fskit", and kextstat lists no macFUSE kext.
    print("\n--- mount | grep mirage ---")
    mounts = subprocess.run(["mount"], capture_output=True, text=True)
    for line in mounts.stdout.splitlines():
        if mp in line:
            print(f"  {line}")

    print("\n--- kextstat | grep -i fuse (expect no rows) ---")
    kexts = subprocess.run(["kextstat"], capture_output=True, text=True)
    rows = [ln for ln in kexts.stdout.splitlines() if "fuse" in ln.lower()]
    print(f"  {len(rows)} macFUSE kext(s) loaded")

    print(f"\n>>> mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls -la {mp}/")
    print(f">>>   cat {mp}/example.json | jq .")
    print(f">>>   wc -c {mp}/example.json")
    print(">>> Press Enter to unmount and exit...")
    input()

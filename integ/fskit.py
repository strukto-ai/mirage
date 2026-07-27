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
"""Mount one RAM resource over macFUSE's FSKit backend and read it back.

Separate from integ/fuse.py because neither scenario there can run here:
the sizeless probe is refused by the fskit size guard by design, and the
multi-mount scenario needs two mounts in one process, which macOS forbids.

Emits its result as one JSON line for integ/check_json.py.
"""

import json
import os
import subprocess

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.resource.ram import RAMResource

CONTENT = b'{"messages": 2}\n'
WRITTEN = b"beta\n"


def mount_line(mountpoint: str) -> str:
    """Return the mount(8) row for a mountpoint, or "" if it is not mounted.

    Args:
        mountpoint (str): the path to look for.

    Returns:
        str: the matching mount table line.
    """
    out = subprocess.run(["mount"], capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if mountpoint in line:
            return line
    return ""


def kext_loaded() -> bool:
    """Report whether a macFUSE kernel extension is loaded.

    Returns:
        bool: True if kextstat lists one.
    """
    kexts = subprocess.run(["kextstat"], capture_output=True, text=True)
    return any("macfuse" in ln.lower() for ln in kexts.stdout.splitlines())


def describe(mountpoint: str) -> None:
    """Print what the kernel thinks of a mountpoint, before reading it.

    Emitted eagerly and in plain text: if the read below fails, this is the
    only evidence of whether the volume came up at all. check_json.py reads
    JSON lines only, so these are ignored by the check.

    Args:
        mountpoint (str): the mountpoint to describe.
    """
    print(f"# mountpoint: {mountpoint}")
    print(f"# exists={os.path.exists(mountpoint)} "
          f"isdir={os.path.isdir(mountpoint)} "
          f"ismount={os.path.ismount(mountpoint)}")
    print(f"# mount row: {mount_line(mountpoint) or '(not in mount table)'}")
    try:
        print(f"# listdir: {sorted(os.listdir(mountpoint))}")
    except OSError as err:
        print(f"# listdir failed: {err!r}")


def main() -> None:
    data = RAMResource()
    data._store.dirs.add("/")
    data._store.files["/api.json"] = CONTENT

    with Workspace({
            "/data":
            Mount(data, mode=MountMode.WRITE, backend=MountBackend.FSKIT),
    }) as ws:
        mp = ws.fuse_mountpoints["/data"]
        describe(mp)
        line = mount_line(mp)

        with open(f"{mp}/api.json", "rb") as fh:
            body = fh.read()
        with open(f"{mp}/written.txt", "wb") as fh:
            fh.write(WRITTEN)
        with open(f"{mp}/written.txt", "rb") as fh:
            echo = fh.read()

        result = {
            # Volatile, reported but never asserted.
            "mountpoint": mp,
            "mount_line": line,
            "under_volumes": mp.startswith("/Volumes/"),
            # The mount table tagging the volume fskit is the proof that the
            # FSKit path served this mount rather than the kext.
            "tagged_fskit": "fskit" in line,
            # Reported, not asserted: whether a kext happens to be loaded is
            # a property of the host, not of the mount. A CI runner never
            # approves one; a developer Mac may already have.
            "kext_loaded": kext_loaded(),
            "cat": body.decode().strip(),
            # FSKit has no direct_io equivalent, so a read is driven entirely
            # by the size stat reports. These two agreeing is what the
            # SIZES_ALWAYS_KNOWN guard exists to guarantee.
            "size": os.path.getsize(f"{mp}/api.json"),
            "read_bytes": len(body),
            "write_roundtrip": echo == WRITTEN,
        }
        print(json.dumps(result))


if __name__ == "__main__":
    main()

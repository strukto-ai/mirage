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

Separate from integ/fuse/fuse.py because neither scenario there can run here:
the sizeless probe is refused by the fskit size guard by design, and the
multi-mount scenario needs two mounts in one process, which macOS forbids.

Emits its result as one JSON line for integ/check_json.py.
"""

import errno
import json
import os
import subprocess
import time
from typing import Callable

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.resource.ram import RAMResource

CONTENT = b'{"messages": 2}\n'
EXISTING = b"old\n"


def wait_store(resource: RAMResource, path: str, want: bytes) -> bool:
    """Poll the backing store until it holds the expected bytes.

    The FSKit shim flushes kernel writes lazily (WRITE arrives after close,
    with no FLUSH), so the store lags the kernel view briefly.

    Args:
        resource (RAMResource): the mounted resource.
        path (str): store path to watch.
        want (bytes): expected content.

    Returns:
        bool: True when the store matched within the window.
    """
    for _ in range(50):
        if resource._store.files.get(path) == want:
            return True
        time.sleep(0.2)
    return False


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


def attempt(fn: Callable[[], object]) -> str:
    """Run a filesystem op and name its outcome.

    Args:
        fn (Callable[[], object]): the operation to attempt.

    Returns:
        str: "ok", or the errno name the kernel returned.
    """
    try:
        fn()
        return "ok"
    except OSError as err:
        return errno.errorcode.get(err.errno or 0, str(err.errno))


def sh(script: str) -> str:
    """Run a shell one-liner against the mount from a child process.

    Writes go through a child on purpose: they exercise the path a real
    user takes, and the serving process's own I/O bypasses the kernel cache
    over fskit, which behaves differently.

    Args:
        script (str): the shell command.

    Returns:
        str: "ok" on exit 0, else the first stderr line or the exit code.
    """
    proc = subprocess.run(["/bin/sh", "-c", script],
                          capture_output=True,
                          text=True,
                          timeout=60)
    if proc.returncode == 0:
        return "ok"
    detail = proc.stderr.strip().splitlines()
    return detail[0] if detail else f"exit {proc.returncode}"


def main() -> None:
    data = RAMResource()
    data._store.dirs.add("/")
    data._store.files["/api.json"] = CONTENT
    data._store.files["/existing.txt"] = EXISTING

    with Workspace({
            "/data":
            Mount(data, mode=MountMode.WRITE, backend=MountBackend.FSKIT),
    }) as ws:
        mp = ws.fuse_mountpoints["/data"]
        describe(mp)
        line = mount_line(mp)

        with open(f"{mp}/api.json", "rb") as fh:
            body = fh.read()
        stat_size = os.path.getsize(f"{mp}/api.json")

        # The metadata write surface works because mirage installs macFUSE's
        # Darwin-only callbacks (mirage/fuse/darwin.py): the FSKit shim
        # finalizes every created item through setattr_x and routes rename
        # through renamex, both of which mfusepy leaves as NULL slots. With
        # them missing, create/mkdir failed with ENOSYS after the op had
        # already applied, and rename never reached userspace.
        # The shim never flushes on close (the kext does): dirty pages sit in
        # the kernel until something forces writeback, so the data writes
        # below run `sync` to make the flush deterministic. Whether appended
        # bytes survive is nondeterministic even then (measured: intact or
        # zeroed depending on cache state), so only the op result is pinned;
        # check_writes warns about exactly this at mount time.
        in_place = sh(f"printf 'more\\n' >> {mp}/existing.txt && sync")
        create = sh(f"touch {mp}/new.txt")
        make_dir = sh(f"mkdir {mp}/sub")
        rename = sh(f"mv {mp}/api.json {mp}/moved.json")
        remove = sh(f"rm {mp}/existing.txt")
        write_new = sh(f"printf 'fresh\\n' > {mp}/new.txt && sync")
        # Measured macFUSE FSKit shim bug, pinned so a fix is noticed: pages
        # for regions a file did NOT already have (a new file, an empty file,
        # or a truncate-then-write) flush as NUL bytes of the right length.
        # The writer sees no error, which is exactly why this went unnoticed.
        # When a macFUSE release starts delivering real bytes, this turns
        # False and the truth check flags it; flip the expectation and
        # delete the caveat.
        new_file_store_zeroed = wait_store(data, "/new.txt",
                                           b"\x00" * len(b"fresh\n"))

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
            "size": stat_size,
            "read_bytes": len(body),
            "write_in_place": in_place,
            "create_file": create,
            "mkdir": make_dir,
            "rename": rename,
            "unlink": remove,
            "new_file_write": write_new,
            "new_file_store_zeroed": new_file_store_zeroed,
        }
        print(json.dumps(result))


if __name__ == "__main__":
    main()

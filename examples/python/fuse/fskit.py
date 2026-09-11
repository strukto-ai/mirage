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
"""Mount over Apple's FSKit, with no kernel extension loaded.

Needs macOS 15.4+ and macFUSE 5.x with its FSKit module enabled. Run it:

    ./python/.venv/bin/python examples/python/fuse/fskit.py

It mounts, exercises reads and writes, and shows the two things that will
bite you. Reads: FSKit clamps every read to the size reported at lookup, so
API-backed resources whose file sizes are unknown before a read mount with
a warning and their files read as empty. Writes: the metadata surface
(create/mkdir/rename/unlink) works because mirage installs macFUSE's
Darwin-only callbacks (mirage/fuse/darwin.py), and appends to existing
bytes persist, but the shim flushes pages a file did not already have (a
new file, or truncate-then-write) as NUL bytes of the right length; the
kernel's own cache reads them back fine, which hides it. That last part is
a macFUSE FSKit shim bug, pinned in integ/fuse/truth_fskit.json.
"""

import errno
import logging
import os
import subprocess
from typing import Callable

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.fuse.backend import check_sizes
from mirage.resource.ram import RAMResource

CONTENT = b'{"messages": 2}\n'


class SizeUnknownRAM(RAMResource):
    """A resource that cannot size its files, like Slack or Gmail."""

    SIZES_ALWAYS_KNOWN = False


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


def show_size_warning() -> None:
    """Show the mount-time warning for a size-unknown resource.

    The warning is demonstrated through ``check_sizes`` directly (the same
    guard every fskit mount path runs) rather than a second kernel mount,
    because macOS allows one FUSE mount per process and the working mount
    below needs it.
    """
    print("=== the size warning ===")
    ws = Workspace({"/api": Mount(SizeUnknownRAM(), mode=MountMode.READ)})
    check_sizes(MountBackend.FSKIT, ws.fs, "")
    print("  FSKit has no direct_io: a read is clamped to the size stat")
    print("  reported at lookup, and that clamp is never refreshed. A")
    print("  size-unknown file mounts anyway, stats as 0, and reads as")
    print("  empty, so the mount logs the warning above naming the mounts")
    print("  affected. Size push-down (issue #83) closes this per backend.\n")


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="  warning: %(message)s")
    show_size_warning()

    data = RAMResource()
    data._store.dirs.add("/")
    data._store.files["/api.json"] = CONTENT
    data._store.files["/existing.txt"] = b"old\n"

    with Workspace({
            "/data":
            Mount(data, mode=MountMode.WRITE, backend=MountBackend.FSKIT),
    }) as ws:
        mp = ws.fuse_mountpoints["/data"]
        print(f"=== mounted at {mp} ===")

        rows = subprocess.run(["mount"], capture_output=True, text=True)
        for line in rows.stdout.splitlines():
            if mp in line:
                print(f"  {line}")
        kexts = subprocess.run(["kextstat"], capture_output=True, text=True)
        loaded = [ln for ln in kexts.stdout.splitlines() if "macfuse" in ln]
        print(f"  macFUSE kexts loaded: {len(loaded)}")
        print("  (the mount row says fskit; a kext here is your machine's,")
        print("   this mount does not use it)\n")

        print("=== reads ===")
        with open(f"{mp}/api.json", "rb") as fh:
            body = fh.read()
        print(f"  cat api.json  -> {body.decode().strip()}")
        print(f"  stat size     -> {os.path.getsize(f'{mp}/api.json')}")
        print(f"  bytes read    -> {len(body)}")
        print("  the two agree, which is what fskit needs sizes for\n")

        print("=== writes: metadata plus appends ===")
        print("  append to existing -> " +
              attempt(lambda: open(f"{mp}/existing.txt", "ab").write(b"x\n")))
        print("  unlink existing    -> " +
              attempt(lambda: os.unlink(f"{mp}/existing.txt")))
        print("  create new file    -> " +
              attempt(lambda: open(f"{mp}/new.txt", "wb").close()))
        print("  mkdir              -> " +
              attempt(lambda: os.mkdir(f"{mp}/sub")))
        print("  rename             -> " +
              attempt(lambda: os.rename(f"{mp}/api.json", f"{mp}/moved.json")))
        payload = b"fresh\n"
        with open(f"{mp}/new.txt", "wb") as out:
            out.write(payload)
        with open(f"{mp}/new.txt", "rb") as back:
            echoed = back.read() == payload
        print(f"  new-file roundtrip -> {'ok' if echoed else 'MISMATCH'}")
        print("  caveat: that roundtrip is served by the kernel cache; the")
        print("  shim flushes new-file pages to the store as NUL bytes")
        print("  (macFUSE FSKit bug, pinned in integ/fuse/truth_fskit.json)")

        print(f"\n>>> mounted at {mp}")
        print(">>> From another terminal try:")
        print(f">>>   ls -la {mp}/")
        print(f">>>   wc -c {mp}/api.json")
        print(">>> Press Enter to unmount and exit...")
        input()


if __name__ == "__main__":
    main()

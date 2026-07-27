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

It mounts, reads, then shows the two things that will bite you: the size
guard that refuses API-backed resources, and the partial write surface.
"""

import errno
import os
import subprocess
from typing import Callable

from mirage import Mount, MountBackend, MountMode, Workspace
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


def show_size_guard() -> None:
    """Show FSKit refusing a resource whose sizes are unknown."""
    print("=== the size guard ===")
    try:
        Workspace({
            "/api":
            Mount(SizeUnknownRAM(),
                  mode=MountMode.READ,
                  backend=MountBackend.FSKIT),
        })
        print("  mounted (unexpected)")
    except RuntimeError as err:
        print(f"  refused: {err}")
    print("  FSKit has no direct_io, so a read is driven entirely by the")
    print("  size stat reports. A resource that cannot size its files would")
    print("  serve silent empty files, so mirage refuses up front.\n")


def main() -> None:
    show_size_guard()

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
        print("  the two agree, which is the whole point of the guard\n")

        print("=== writes: only part of the surface works ===")
        print("  append to existing -> " +
              attempt(lambda: open(f"{mp}/existing.txt", "ab").write(b"x\n")))
        print("  unlink existing    -> " +
              attempt(lambda: os.unlink(f"{mp}/existing.txt")))
        created = attempt(lambda: open(f"{mp}/new.txt", "wb").close())
        print(f"  create new file    -> {created}")
        print("  mkdir              -> " +
              attempt(lambda: os.mkdir(f"{mp}/sub")))
        print("  rename             -> " +
              attempt(lambda: os.rename(f"{mp}/api.json", f"{mp}/moved.json")))
        if created != "ok":
            # The failure is not clean: the syscall reports ENOSYS and the
            # file is there anyway, so "it failed" does not mean "nothing
            # happened". Anything that creates files (git clone, pip
            # install, a compiler) will not work on an FSKit mount.
            print(f"\n  new.txt exists anyway: "
                  f"{os.path.exists(f'{mp}/new.txt')}")
            print("  a create that reports ENOSYS still applied, so do not")
            print("  treat the error as 'nothing happened'. Use")
            print("  MountBackend.FUSE for write workloads.")

        print(f"\n>>> mounted at {mp}")
        print(">>> From another terminal try:")
        print(f">>>   ls -la {mp}/")
        print(f">>>   wc -c {mp}/api.json")
        print(">>> Press Enter to unmount and exit...")
        input()


if __name__ == "__main__":
    main()

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
import errno
import os
import stat as stat_mod
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource

# Captured before any workspace opens, so the block below can show that
# the patch reached the module THIS file imported rather than a copy
# only code imported inside the block would see.
HOST_LISTDIR = os.listdir

# A fixed stamp, so the utime section prints the same line every run.
STAMP = 1_700_000_000

resource = RAMResource()


def label(exc: OSError) -> str:
    """The errno's own name, never the host's strerror text.

    macOS and Linux word the same condition differently (EXDEV is
    "Cross-device link" on one and "Invalid cross-device link" on the
    other), so a printed strerror would be a different line per host.
    """
    return {
        errno.EPERM: "EPERM",
        errno.EXDEV: "EXDEV",
        errno.ENOTSUP: "ENOTSUP",
        errno.ENOENT: "ENOENT",
    }.get(exc.errno, str(exc.errno))


async def main():
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)

    await ws.execute('echo "hello world" | tee /data/hello.txt')
    await ws.execute("mkdir /data/sub")
    await ws.execute('echo "nested" | tee /data/sub/nested.txt')

    with ws:
        print("=== VFS MODE ===\n")

        # The doors are installed on the real `os` module, not swapped
        # into sys.modules, so this file's own import routes.
        print("--- import os ---")
        print(f"  patched in place: {os.listdir is not HOST_LISTDIR}")

        print("\n--- os.listdir() ---")
        for entry in sorted(os.listdir("/data")):
            print(f"  {entry}")

        print("\n--- open() + read ---")
        with open("/data/hello.txt") as f:
            print(f"  {f.read().strip()}")

        print("\n--- os.stat() ---")
        st = os.stat("/data/hello.txt")
        print(f"  hello.txt: {st.st_size} bytes, "
              f"regular file: {stat_mod.S_ISREG(st.st_mode)}")
        print(f"  sub: directory: "
              f"{stat_mod.S_ISDIR(os.stat('/data/sub').st_mode)}")

        print("\n--- os.walk() ---")
        for top, dirs, files in os.walk("/data"):
            print(f"  {top}: dirs={sorted(dirs)} files={sorted(files)}")

        print("\n--- os.scandir() ---")
        with os.scandir("/data") as it:
            for entry in sorted(it, key=lambda e: e.name):
                print(f"  {entry.name}: "
                      f"{'dir' if entry.is_dir() else 'file'}")

        print("\n--- os.path.* ---")
        print(f"  exists hello.txt: {os.path.exists('/data/hello.txt')}")
        print(f"  exists nope.txt: {os.path.exists('/data/nope.txt')}")
        print(f"  isdir /data/sub: {os.path.isdir('/data/sub')}")
        print(f"  getsize hello.txt: {os.path.getsize('/data/hello.txt')}")

        print("\n--- os.makedirs() ---")
        os.makedirs("/data/deep/a/b", exist_ok=True)
        print(f"  /data/deep/a/b: {os.path.isdir('/data/deep/a/b')}")

        print("\n--- symlinks ---")
        os.symlink("hello.txt", "/data/link")
        print(f"  readlink: {os.readlink('/data/link')}")
        print(f"  islink: {os.path.islink('/data/link')}")
        print("  lstat is a link: "
              f"{stat_mod.S_ISLNK(os.lstat('/data/link').st_mode)}")
        print(f"  stat follows it: {os.stat('/data/link').st_size} bytes")
        # A link has an owner of its own that chown -h writes, so lstat
        # reads the link's row rather than rebuilding one from the
        # target string. Its bits stay lrwxrwxrwx whatever chmod -h says.
        os.lchown("/data/link", 4242, 4343)
        link_st = os.lstat("/data/link")
        print(f"  lchown then lstat: {link_st.st_uid}:{link_st.st_gid} "
              f"mode {oct(stat_mod.S_IMODE(link_st.st_mode))}")

        print("\n--- metadata ---")
        os.chmod("/data/hello.txt", 0o600)
        mode = stat_mod.S_IMODE(os.stat("/data/hello.txt").st_mode)
        print(f"  chmod: {oct(mode)}")
        os.utime("/data/hello.txt", (STAMP, STAMP))
        stamped = datetime.fromtimestamp(os.path.getmtime("/data/hello.txt"),
                                         timezone.utc)
        print(f"  utime: {stamped.isoformat()}")

        print("\n--- pathlib ---")
        # pathlib holds its own reference to `io.open` and to `os`, so it
        # routes only because both are patched by name.
        path = Path("/data/sub/nested.txt")
        print(f"  read_text: {path.read_text().strip()}")
        print(f"  exists: {path.exists()}")
        print(f"  iterdir: {sorted(p.name for p in Path('/data').iterdir())}")

        print("\n--- refused on a mount ---")
        # A verb whose fact no mount can hold answers the errno POSIX
        # gives a filesystem that cannot hold it, rather than reaching
        # the host with a mounted path in hand.
        try:
            os.link("/data/hello.txt", "/data/hard")
        except OSError as exc:
            print(f"  os.link: {label(exc)}")
        try:
            os.open("/data/hello.txt", os.O_RDONLY)
        except OSError as exc:
            print(f"  os.open: {label(exc)}")
        try:
            os.statvfs("/data")
        except OSError as exc:
            print(f"  os.statvfs: {label(exc)}")

        print("\n--- one end off the mount ---")
        host = tempfile.mkdtemp()
        try:
            os.rename("/data/hello.txt", f"{host}/hello.txt")
        except OSError as exc:
            print(f"  os.rename to the host: {label(exc)}")
        Path(f"{host}/from_host.txt").write_text("host bytes\n")
        print(f"  host path still reads: "
              f"{Path(f'{host}/from_host.txt').read_text().strip()}")
        os.symlink(f"{host}/from_host.txt", f"{host}/host_link")
        # A bytes path is a host spelling no mount serves, and
        # os.readlink answers one with bytes, not with a str of them.
        read = os.readlink(os.fsencode(f"{host}/host_link"))
        print(f"  host readlink(bytes): {os.path.basename(read)!r}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())

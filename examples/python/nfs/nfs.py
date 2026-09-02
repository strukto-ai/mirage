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
"""Mount a workspace over NFS, with no FUSE driver installed.

Needs the mirage-nfs extension (``pip install ./python/mirage-nfs``) and a
kernel NFS client, which macOS and Linux both ship. Run it:

    ./python/.venv/bin/python examples/python/nfs/nfs.py

On macOS a loopback mount needs no privileges at all; on Linux ``mount``
does, so run it under sudo there.

Two rules the code below follows, and you must too:

* Every touch of the mountpoint leaves this event loop, because the loop
  is what answers the NFS request. A plain ``open()`` here would block
  the loop that has to serve it, so reads go through a subprocess.
* One server backs every prefix. The second mount below costs a kernel
  mount, not a second server, which is how a workspace exposes many
  subtrees on a platform that allows one FUSE mount per process.
"""

import asyncio

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.resource.ram import RAMResource


async def sh(*argv: str) -> tuple[int, str]:
    """Run one command off-loop and capture its output.

    Args:
        argv (str): the command and its arguments.

    Returns:
        tuple[int, str]: exit code and combined output.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def main() -> None:
    ws = Workspace(
        {
            "/data":
            Mount(
                RAMResource(), mode=MountMode.WRITE, backend=MountBackend.NFS)
        },
        mode=MountMode.WRITE)
    try:
        await ws.execute("echo 'hello over nfs' > /data/hello.txt")
        await ws.execute("mkdir -p /data/docs && echo beta > /data/docs/b.txt")

        # The constructor cannot await, so the declared mount comes up on
        # the first `execute` above; `nfs_ready` is the explicit spelling.
        await ws.nfs_ready()
        mountpoint = ws.nfs_mountpoints["/data"]
        print(f"=== NFS MODE: /data mounted at {mountpoint} ===\n")

        _, listing = await sh("ls", "-1", mountpoint)
        print(f"ls {mountpoint}\n{listing}\n")
        _, text = await sh("cat", f"{mountpoint}/hello.txt")
        print(f"cat hello.txt -> {text!r}")

        # A write through the kernel is buffered per open handle: this
        # server never sees a COMMIT, so the bytes reach the resource on
        # the idle flush (NFSConfig.idle_flush_seconds, 5s by default) or
        # at close. Reads through the mount see them at once, because the
        # adapter merges the buffer; mirage's own command surface lags
        # until the flush.
        line = f"echo 'written by the kernel' > {mountpoint}/kernel.txt"
        await sh("sh", "-c", line)
        _, text = await sh("cat", f"{mountpoint}/kernel.txt")
        print(f"\ncat kernel.txt through the mount -> {text!r}")
        early = await ws.execute("cat /data/kernel.txt")
        print("mirage before the flush     -> "
              f"{(await early.stdout_str()).strip()!r}")
        # The sweep runs every idle_flush_seconds and flushes handles
        # idle that long, so the worst case is two windows.
        print("waiting ~12s for the idle flush...")
        await asyncio.sleep(12)
        late = await ws.execute("cat /data/kernel.txt")
        print("mirage after the flush      -> "
              f"{(await late.stdout_str()).strip()!r}")

        # One server, a second export: /data/docs gets its own mountpoint.
        docs = await ws.add_nfs_mount("/data/docs")
        print(f"\nsecond mount (same server): {docs}")
        _, text = await sh("cat", f"{docs}/b.txt")
        print(f"cat b.txt -> {text!r}")
        print(f"live mounts: {ws.nfs_mountpoints}")
    finally:
        # Unmounts every export, flushes buffered writes, stops the
        # server. The order matters: the kernel flushes its dirty pages
        # as final WRITEs while the server is still up.
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())

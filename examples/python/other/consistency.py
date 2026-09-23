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
import tempfile

from mirage import MountMode, Workspace
from mirage.types import ReadPolicy, ReadSpec
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS


def _banner(title: str) -> None:
    print(f"\n=== {title} ===")


def refusals() -> None:
    """A policy that cannot act says so, at mount time.

    `fresh` revalidates cached bytes against the backend before serving
    them. A backend that does not cache reads never reaches that gate, so
    declaring `fresh` on one would read as enabled and do nothing. That
    silent downgrade is what the refusal exists to prevent.
    """
    _banner("read: fresh is refused where it cannot act")
    fresh = ReadSpec(policy=ReadPolicy.FRESH)
    with tempfile.TemporaryDirectory() as root:
        for name, vfs in (("ram", RAMVFS()), ("disk", DiskVFS(root=root))):
            try:
                Workspace({"/data": vfs}, mode=MountMode.WRITE, read=fresh)
                print(f"{name}: accepted (unexpected)")
            except ValueError as exc:
                print(f"{name}: {exc}")

    _banner("read: pinned names the layer it needs")
    try:
        Workspace({"/data": RAMVFS()},
                  mode=MountMode.WRITE,
                  read=ReadSpec(policy=ReadPolicy.PINNED))
    except ValueError as exc:
        print(exc)


async def bounds() -> None:
    """`bounded` is the default, and the bound is per mount."""
    _banner("read: bounded, with a per-mount bound")
    ws = Workspace(
        {
            "/fast": RAMVFS(),
            "/slow": RAMVFS(),
        },
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=600),
    )
    try:
        for mount in sorted(ws._registry.mounts(), key=lambda m: m.prefix):
            spec = mount.read
            print(f"{mount.prefix:16} {spec.policy.value} ttl={spec.ttl}")
    finally:
        await ws.close()


async def main() -> None:
    """Demonstrate the per-mount read policy.

    Kept at this filename although the workspace-wide
    ``ConsistencyPolicy`` it was written for is gone; the policy it
    shows is now declared per mount.
    """
    refusals()
    await bounds()


if __name__ == "__main__":
    asyncio.run(main())

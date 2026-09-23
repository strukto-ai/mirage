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
import shutil
import tempfile
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.types import PathSpec
from mirage.vfs.disk import DiskVFS

MOUNT = "/data"


def seed(root: Path) -> None:
    """Lay down the files the baseline pull will record.

    Args:
        root (Path): Directory the mount is rooted at.
    """
    (root / "reports").mkdir()
    (root / "reports" / "q1.txt").write_text("first quarter\n")
    (root / "reports" / "q2.txt").write_text("second quarter\n")


def write_behind_mirage(root: Path) -> None:
    """Change the directory the way an outside writer would.

    Nothing here goes through the workspace: this stands in for the
    teammate, cron job or pipeline that mirage has to detect rather
    than be told about.

    Args:
        root (Path): Directory the mount is rooted at.
    """
    (root / "reports" / "q3.txt").write_text("third quarter\n")
    (root / "reports" / "q1.txt").write_text("first quarter, revised\n")
    (root / "reports" / "q2.txt").unlink()


async def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    seed(tmp)

    vfs = DiskVFS(root=str(tmp))
    ws = Workspace({MOUNT: vfs}, mode=MountMode.READ)
    hook = vfs.delta_hook()
    root = PathSpec.from_str_path(MOUNT, vfs_path="")

    # A baseline pull records state and reports nothing. Hand the
    # checkpoint back on the next call and it diffs against it.
    delta = await hook.pull(root, None)
    checkpoint = delta.checkpoint
    print(f"baseline: {len(delta.changes)} changes")

    write_behind_mirage(tmp)

    delta = await hook.pull(root, checkpoint)
    print(f"\npull: {len(delta.changes)} changes")
    for change in sorted(delta.changes, key=lambda c: c.path.virtual):
        print(f"  {change.kind.value:6} {change.path.virtual}")
        await ws.notify(change)

    # notify invalidates the caches for the changed path and its
    # ancestor listings before delivering, so a read after an event
    # can never serve pre-change bytes.
    result = await ws.shell(f"cat {MOUNT}/reports/q1.txt")
    print(f"\nread after notify: {(await result.stdout_str()).strip()!r}")
    result = await ws.shell(f"ls {MOUNT}/reports")
    print(f"listing: {' '.join((await result.stdout_str()).split())}")

    await ws.close()
    shutil.rmtree(tmp)


asyncio.run(main())

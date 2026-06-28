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
import shutil
import tempfile

from mirage import Mount, MountMode, Workspace
from mirage.resource.ram import RAMResource


def main() -> None:
    data = RAMResource()
    data._store.dirs.add("/")
    data._store.files["/a.txt"] = b"alpha\n"
    logs = RAMResource()
    logs._store.dirs.add("/")
    logs._store.files["/b.txt"] = b"beta\n"

    pinned = os.path.join(tempfile.gettempdir(),
                          f"mirage-fuse-data-{os.getpid()}")
    shutil.rmtree(pinned, ignore_errors=True)
    # Mount via the public per-mount Mount spec (what examples/users write):
    # /data pins its mountpoint and overrides the workspace default to WRITE;
    # /logs gets a generated mountpoint and inherits the default READ.
    with Workspace({
            "/data": Mount(data, mode=MountMode.WRITE, fuse=pinned),
            "/logs": Mount(logs, fuse=True),
    }) as ws:
        data_mp = ws.fuse_mountpoints["/data"]
        logs_mp = ws.fuse_mountpoints["/logs"]

        with open(f"{data_mp}/a.txt", "rb") as fh:
            print(f"data_cat_a={fh.read().decode().strip()}")
        with open(f"{logs_mp}/b.txt", "rb") as fh:
            print(f"logs_cat_b={fh.read().decode().strip()}")
        print(f"logs_size_b={os.path.getsize(f'{logs_mp}/b.txt')}")
        print(f"data_pinned={'yes' if data_mp == pinned else 'no'}")
        print(f"distinct_mounts={'yes' if data_mp != logs_mp else 'no'}")

        write_ok = ws.mount("/data").mode == MountMode.WRITE
        read_ok = ws.mount("/logs").mode == MountMode.READ
        print(f"data_mode_is_write={'yes' if write_ok else 'no'}")
        print(f"logs_mode_is_read={'yes' if read_ok else 'no'}")

        try:
            _ = ws.fuse_mountpoint
            singular = "no"
        except RuntimeError:
            singular = "yes"
        print(f"singular_raises_multi={singular}")

        try:
            ws.add_fuse_mount("/collide", pinned)
            collision = "no"
        except ValueError:
            collision = "yes"
        print(f"collision_rejected={collision}")


if __name__ == "__main__":
    main()

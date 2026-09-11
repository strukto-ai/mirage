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
import json
import struct

from mirage import MountMode, Workspace
from mirage.commands.registry import RegisteredCommand
from mirage.commands.spec import SPECS
from mirage.core.ram.read import read_bytes
from mirage.io.types import IOResult
from mirage.resource.ram import RAMResource

MAGIC = b"TALLY1"


def encode(counts: dict[str, int]) -> bytes:
    body = json.dumps(counts, sort_keys=True).encode()
    return MAGIC + struct.pack("<I", len(body)) + body


async def tally_cat(accessor, paths, *texts, **kwargs):
    """Render a .tally file as one "name count" line per entry.

    Args:
        accessor (Accessor): backend handle injected by the dispatcher.
        paths (list[PathSpec]): operands, already glob-resolved.
        texts (str): positional text operands, unused here.
    """
    path = paths[0]
    raw = await read_bytes(accessor, path)
    if not raw.startswith(MAGIC):
        return None, IOResult(exit_code=1, stderr=b"cat: not a tally file\n")
    size = struct.unpack("<I", raw[len(MAGIC):len(MAGIC) + 4])[0]
    body = json.loads(raw[len(MAGIC) + 4:len(MAGIC) + 4 + size])
    out = "".join(f"{k} {v}\n" for k, v in body.items())
    return out.encode(), IOResult(cache=[path.mount_path])


async def main() -> None:
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)

    await ws.fs.write("/data/hits.tally", encode({"alpha": 3, "beta": 11}))
    await ws.fs.write("/data/notes.txt", b"plain text\n")

    mount = ws.mount("/data/")
    mount.register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".tally",
                          fn=tally_cat))

    # .tally routes to the renderer above; .txt falls back to the generic cat.
    print((await ws.execute("cat /data/hits.tally")).stdout.decode(), end="")
    print((await ws.execute("cat /data/notes.txt")).stdout.decode(), end="")

    # The renderer composes with the rest of the shell like any other command.
    out = await ws.execute("cat /data/hits.tally | sort -k2 -n | tail -1")
    print("largest:", out.stdout.decode().strip())


if __name__ == "__main__":
    asyncio.run(main())

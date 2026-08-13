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

from mirage.accessor.s3 import S3Accessor
from mirage.commands.builtin.s3.io import resolve_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.s3.exists import exists
from mirage.core.s3.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("touch", resource="s3", spec=SPECS["touch"], write=True)
async def touch(
    accessor: S3Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("touch: missing operand")
    fl = FlagView(opts.flags, spec=SPECS["touch"])
    paths = await resolve_glob(accessor, paths, opts.index)
    writes: dict[str, ByteSource] = {}
    for p in paths:
        if fl.as_bool("c"):
            continue
        if not await exists(accessor, p):
            await write_bytes(accessor, p, b"")
            writes[p.mount_path] = b""
    return None, IOResult(writes=writes)

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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.commands.builtin.generic_bind.adapter import scan_io
from mirage.commands.builtin.generic_bind.search import run_search
from mirage.commands.builtin.mongodb.io import IO
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", vfs="mongodb", spec=SPECS["rg"])
async def rg(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    scan, _ = scan_io(IO, opts.ns, opts.mount_prefix)
    return await run_search(scan, "rg", accessor, paths, texts, opts)

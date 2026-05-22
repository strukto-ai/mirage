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

import re
from collections.abc import AsyncIterator

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.sed_helper import (_execute_program,
                                                _parse_one_command,
                                                _parse_program)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("sed", resource="gdrive", spec=SPECS["sed"])
async def sed(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    e: bool = False,
    n: bool = False,
    E: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if i:
        raise PermissionError(
            "sed -i not supported on read-only Google Docs mount")
    if not texts:
        raise ValueError("sed: usage: sed EXPRESSION [path]")

    if ";" in texts[0] or "{" in texts[0]:
        commands = _parse_program(texts[0])
    else:
        commands = [_parse_one_command(texts[0])[0]]

    is_simple_sub = (len(commands) == 1 and commands[0]["cmd"] == "s"
                     and commands[0].get("addr_start") is None and not n)

    if is_simple_sub and paths:
        parsed = commands[0]
        re_flags = re.IGNORECASE if "i" in parsed["expr_flags"] else 0
        count = 0 if "g" in parsed["expr_flags"] else 1
        outputs: list[str] = []
        for p in paths:
            data = await gdrive_read(accessor, p, index)
            text = data.decode(errors="replace")
            new_text = re.sub(parsed["pattern"],
                              parsed["replacement"],
                              text,
                              flags=re_flags,
                              count=count)
            outputs.append(new_text)
        return "".join(outputs).encode(), IOResult()

    if paths:
        paths = await resolve_glob(accessor, paths, index)
        p = paths[0]
        data = await gdrive_read(accessor, p, index)
        text = data.decode(errors="replace")
        result = _execute_program(text, commands, suppress=n)
        return result.encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("sed: usage: sed EXPRESSION path")
    text = raw.decode(errors="replace")
    result = _execute_program(text, commands, suppress=n)
    return result.encode(), IOResult()

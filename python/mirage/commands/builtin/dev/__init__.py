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

from collections.abc import AsyncIterator

from mirage.commands.builtin.generic_bind.factory import generic_reading
from mirage.commands.config import Context
from mirage.core.dev.constants import ZERO_CHUNK_SIZE
from mirage.types import PathSpec
from mirage.workspace.files import Files


async def _ranged(files: Files, path: PathSpec) -> AsyncIterator[bytes]:
    """Stream ``path`` as successive ranged reads of its stored bytes.

    ``/dev/zero`` answers every range in full, so the stream ends only
    when the reader stops; ``/dev/null`` and a regular file end at the
    first short range. Each range is a dispatcher read, so hides, path rules
    and policies judge it.

    Args:
        files (Files): the command's files.
        path (PathSpec): the file.
    """
    offset = 0
    while True:
        chunk = await files.read(path, offset, ZERO_CHUNK_SIZE, raw=True)
        if chunk:
            yield chunk
        if len(chunk) < ZERO_CHUNK_SIZE:
            return
        offset += len(chunk)


def _endless(ctx: Context, path: PathSpec) -> AsyncIterator[bytes] | None:
    """An operand read in ranges, except a descriptor under ``/fd/``,
    which keeps the dispatched stream.

    Args:
        ctx (Context): the invocation's context.
        path (PathSpec): the operand.
    """
    if ctx.vfs is None or path.mount_path.startswith("/fd/"):
        return None
    return _ranged(ctx.vfs, path)


# /dev is a RAM mount whose read and stat know the two synthetic
# character devices. Commands that consume a whole input read a finite
# stream, while the two bounded streaming commands read in ranges, which
# /dev/zero answers without end.
COMMANDS = [
    generic_reading(name, vfs="ram", stream=_endless)
    for name in ("cat", "head")
]

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

import hashlib

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import own_write_version, writes_conditioned
from mirage.cache.types import OwnRead
from mirage.core.box.api import download_file
from mirage.core.box.fingerprint import live_of
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.core.box.write import write
from mirage.errors.fs import enotsup
from mirage.types import PathSpec


async def truncate(
    accessor: BoxAccessor, path: PathSpec, length: int, no_create: bool = False
) -> None:
    if no_create:
        raise enotsup("box", "truncate --no-create", path)
    if length == 0 and writes_conditioned():
        # Emptying carries the agent's version; no read needed.
        await write(accessor, path, b"")
        return
    item = await resolve_item(accessor, path_parts(path))
    live = live_of(item)
    data = b""
    own: str | OwnRead | None = OwnRead.ABSENT
    if item is not None and live is not None:
        data = await download_file(accessor.token_manager, item["id"])
        own = hashlib.sha1(data).hexdigest()
    if length <= len(data):
        new = data[:length]
    else:
        new = data + b"\x00" * (length - len(data))
    with own_write_version(path, own):
        await write(accessor, path, new)

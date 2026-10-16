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

from contextlib import aclosing

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.utils import join_root, open_for_write
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def append_bytes(
    accessor: SSHAccessor, path_spec: PathSpec, data: bytes
) -> None:
    await append_stream(accessor, path_spec, data)


async def append_stream(
    accessor: SSHAccessor, path: PathSpec, data: ByteSource
) -> None:
    config = accessor.config
    timer = start_op()
    sftp = await accessor.sftp()
    size = 0
    async with (
        aclosing(chunks(data)) as source,
        await open_for_write(
            sftp, join_root(config.root, path.mount_path), path, flags="ab"
        ) as f,
    ):
        async for chunk in source:
            await f.write(chunk)
            size += len(chunk)
    record("append", path.virtual, "ssh", size, timer)

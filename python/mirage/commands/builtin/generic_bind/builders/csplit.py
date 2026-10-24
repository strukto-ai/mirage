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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.crossmount.utils import (
    transfer_primitives,
)
from mirage.commands.builtin.generic.csplit import (
    csplit_generic as generic_csplit,
)
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dispatched_call,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def csplit(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    paths = await resolve_or_empty(files, paths)
    # The pieces go to the prefix, or `xx` in the working directory, which
    # need not be this mount, so a dispatcher routes each write, and the
    # removal of a failed run's pieces, to the mount that owns it.
    dispatch = dispatch_of(ctx)
    return await generic_csplit(
        paths,
        texts,
        ctx,
        read=files.read,
        write_bytes=(
            transfer_primitives(dispatch)["write"]
            if dispatch is not None
            else files.write
        ),
        unlink=(
            partial(dispatched_call, dispatch, "unlink")
            if dispatch is not None
            else files.unlink
        ),
    )


BUILDER = GenericCommand("csplit", csplit, write=True)

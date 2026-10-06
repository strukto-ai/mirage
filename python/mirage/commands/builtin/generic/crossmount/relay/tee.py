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

import functools
from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes,
    relay,
    transfer_primitives,
)
from mirage.commands.builtin.generic.tee import tee_generic
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import ensure_stream
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def run_tee(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Copy stdin to outputs on several mounts with one tee.

    One run sees every output, so ``--output-error=exit`` checks that each
    can be opened before any is written, as GNU opens them all first.
    Each output is written on the mount that owns it, through the
    dispatcher, which also drops its cached copy; ``-a`` goes through the
    append op, which a mount answers natively or by rewriting the file.

    Args:
        scopes (list[PathSpec]): the outputs in command-line order.
        flag_kwargs (dict): flags parsed against the shared tee spec.
        dispatch (DispatchFn): workspace operation dispatcher.
        stdin (ByteSource | None): what tee copies.
    """

    async def read_stream(path: PathSpec) -> AsyncIterator[bytes]:
        data, _ = await dispatch("read", path)
        async for chunk in ensure_stream(data):
            yield chunk

    async def append_bytes(path: PathSpec, data: bytes) -> None:
        await dispatch("append", path, data=data)

    p = functools.partial
    out, io = await tee_generic(
        flat_scopes(scopes),
        [],
        read_stream=read_stream,
        write_bytes=transfer_primitives(dispatch)["write"],
        append_bytes=append_bytes,
        stdin=stdin,
        flags=flag_kwargs,
        stat=p(relay, dispatch, "stat"),
    )
    # Relay writes are keyed by the dispatcher; keyed here they would be
    # prefixed onto one mount.
    return out, IOResult(exit_code=io.exit_code, stderr=io.stderr)

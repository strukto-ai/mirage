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

from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import (
    flat_scopes, transfer_primitives)
from mirage.commands.builtin.generic.zip_cmd import parse_flags, zip_cmd
from mirage.commands.builtin.generic_bind.archive_io import relay_walk_of
from mirage.commands.spec.types import FlagValue
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def run_zip(scopes: list[PathSpec], flag_kwargs: dict[str, FlagValue],
                  dispatch: DispatchFn,
                  ns: NamespaceView | None) -> CrossResult:
    """Run a zip whose archive and operands span mounts.

    Pure wiring: the shared generic plans on dispatch-relayed doors, so
    each operand is walked on the mount that owns it and the archive
    lands on its own. The scan still stops at a mount nested under an
    operand, exactly as it does when the whole line is on one mount.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order;
            the archive is first.
        flag_kwargs (dict): Flags parsed against the shared zip spec.
        dispatch (DispatchFn): Workspace operation dispatcher.
        ns (NamespaceView | None): The symlinks and mount boundaries the
            scan merges into each walk.
    """
    parsed = parse_flags(flag_kwargs)
    prim = transfer_primitives(dispatch)
    return await zip_cmd(flat_scopes(scopes),
                         read_bytes=prim["read_bytes"],
                         write_bytes=prim["write"],
                         stat=prim["stat"],
                         walk=relay_walk_of(
                             dispatch,
                             ns.child_mounts if ns is not None else None),
                         r=parsed.recursive,
                         j=parsed.junk_paths,
                         q=parsed.quiet,
                         y=parsed.store_links,
                         x=list(parsed.exclude) or None,
                         links=ns.links if ns is not None else None,
                         mounts=ns.mounts if ns is not None else None)

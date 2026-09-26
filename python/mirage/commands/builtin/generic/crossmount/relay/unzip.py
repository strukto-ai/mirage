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
from mirage.commands.builtin.generic.crossmount.utils import \
    transfer_primitives
from mirage.commands.builtin.generic.unzip import unzip_generic
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def run_unzip(scopes: list[PathSpec], text_args: list[str],
                    flag_kwargs: dict[str, FlagValue],
                    dispatch: DispatchFn) -> CrossResult:
    """Run an unzip whose archive and -d destination span mounts.

    Pure wiring: the shared generic runs on dispatch-relayed doors, so
    the archive is read from its mount and every extracted path lands
    on whichever mount owns it. The generic reads every flag itself, so
    ``-v`` still lists and ``-x`` still excludes when ``-d`` names
    another mount.

    Args:
        scopes (list[PathSpec]): Path operands; the archive is first.
        text_args (list[str]): Info-ZIP member filespecs, as typed.
        flag_kwargs (dict): Flags parsed against the shared unzip spec,
            with path-valued flags as resolved virtual strings.
        dispatch (DispatchFn): Workspace operation dispatcher.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["unzip"])
    prim = transfer_primitives(dispatch)
    # Scopes arrive in line order and include the -d flag's value, so
    # the archive is the first scope that is not the destination.
    dest = fl.as_str("d")
    operands = [s for s in scopes if s.virtual != dest]
    return await unzip_generic(operands or scopes,
                               list(text_args),
                               CommandOpts(flags=flag_kwargs),
                               read_bytes=prim["read_bytes"],
                               write_bytes=prim["write"],
                               mkdir_fn=prim["mkdir"],
                               stat=prim["stat"],
                               relay=True)

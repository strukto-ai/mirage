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
from mirage.commands.builtin.generic.tar.tar import tar
from mirage.commands.builtin.generic_bind.archive_io import (relay_is_dir_of,
                                                             relay_walk_of)
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


def _operands(scopes: list[PathSpec], taken: list[str]) -> list[PathSpec]:
    """The positional operands among a line's path words.

    The scopes are every path word in line order, an option's value
    among them. The parser gives each option its word first (POSIX
    order, and the order -C needs), so the same words go here and what
    is left are the operands, each with its own spelling.

    Args:
        scopes (list[PathSpec]): Every path word, in line order.
        taken (list[str]): The resolved values the options consumed.
    """
    rest = list(scopes)
    for value in taken:
        key = value.rstrip("/") or "/"
        for index, scope in enumerate(rest):
            if (scope.virtual.rstrip("/") or "/") == key:
                del rest[index]
                break
    return rest


async def run_tar(scopes: list[PathSpec], text_args: list[str],
                  flag_kwargs: dict[str, FlagValue], dispatch: DispatchFn,
                  ns: NamespaceView | None) -> CrossResult:
    """Run a tar whose archive, operands and -C destination span mounts.

    Pure wiring: the shared generic runs on dispatch-relayed doors, so
    the archive is read from or written to its mount, every extracted
    path lands on whichever mount owns it, and each -c operand is walked
    on the mount that owns it. The create scan still stops at a mount
    nested under an operand, exactly as it does on one mount.

    Args:
        scopes (list[PathSpec]): Path words in command-line order.
        text_args (list[str]): The -t/-x member selectors, as typed.
        flag_kwargs (dict): Flags parsed against the shared tar spec,
            with path-valued flags as resolved virtual strings.
        dispatch (DispatchFn): Workspace operation dispatcher.
        ns (NamespaceView | None): The symlinks and mount boundaries the
            create scan merges into each walk.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["tar"])
    prim = transfer_primitives(dispatch)
    archive = fl.as_str("f")
    directories = [str(part) for part in fl.as_list("C")]
    create = fl.as_bool("c")
    operands = (_operands(scopes, [archive, *directories])
                if create and archive else [])
    return await tar(
        flat_scopes(operands),
        read_bytes=prim["read_bytes"],
        write_bytes=prim["write"],
        mkdir_fn=prim["mkdir"],
        stat=prim["stat"],
        walk=relay_walk_of(dispatch,
                           ns.child_mounts if ns is not None else None),
        is_dir=relay_is_dir_of(dispatch),
        selectors=list(text_args),
        c=create,
        x=fl.as_bool("x"),
        t=fl.as_bool("t"),
        z=fl.as_bool("z"),
        j=fl.as_bool("j"),
        J=fl.as_bool("J"),
        v=fl.as_bool("v"),
        h=fl.as_bool("h"),
        to_stdout=fl.as_bool("to_stdout"),
        f=PathSpec.from_str_path(archive) if archive else None,
        C=[PathSpec.from_str_path(d) for d in directories] or None,
        strip_components=fl.as_str("strip_components"),
        exclude=fl.as_str("exclude"),
        links=ns.links if ns is not None else None,
        mounts=ns.mounts if ns is not None else None,
        relay=True,
    )

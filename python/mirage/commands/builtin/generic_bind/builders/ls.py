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
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.ls import facts, ls_generic, ls_options
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import CommandFn, Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# The options dir and vdir list as when nothing else is typed: columns,
# and long, each with names quoted as -b does.
DIR_FORMAT = "C"
VDIR_FORMAT = "args_l"
ESCAPED = {"QUOTING_STYLE": "escape"}


def _parsed(
    ctx: Context, program: str, default_format: str | None
) -> dict[str, Any]:
    if program == "ls":
        return ls_options(ctx.flags, ctx.env)
    env = {**ESCAPED, **(ctx.env or {})}
    try:
        return ls_options(ctx.flags, env, default_format)
    except UsageError as exc:
        said = (
            str(exc)
            .replace("ls: ", f"{program}: ", 1)
            .replace("'ls --help'", f"'{program} --help'")
        )
        raise UsageError(said, exc.exit_code) from exc


def _listing(program: str, default_format: str | None) -> CommandFn:
    async def listing(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        options = _parsed(ctx, program, default_format)
        files = command_files(ctx, paths)
        if not paths:
            paths = [
                PathSpec(
                    virtual=ctx.cwd.virtual,
                    directory=ctx.cwd.virtual,
                    resolved=False,
                    vfs_path=ctx.cwd.vfs_path,
                )
            ]
        resolved = await files.resolve_glob(paths)
        # Only -R reads whole subtrees; a plain listing reads one level.
        readdir, stat = tree_walk(
            files.read_tree,
            files.readdir,
            files.stat,
            FlagView(ctx.flags, spec=SPECS["ls"]).as_bool("recursive")
            and files.answers("read_tree"),
        )
        return await ls_generic(
            resolved, list(texts), ctx, readdir, stat, options, program
        )

    return listing


BUILDER = GenericCommand("ls", _listing("ls", None), facts=facts)
DIR_BUILDER = GenericCommand(
    "dir",
    _listing("dir", DIR_FORMAT),
    facts=partial(facts, default_format=DIR_FORMAT),
)
VDIR_BUILDER = GenericCommand(
    "vdir",
    _listing("vdir", VDIR_FORMAT),
    facts=partial(facts, default_format=VDIR_FORMAT),
)

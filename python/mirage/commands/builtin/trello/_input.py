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

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.builtin.generic_bind.adapter import mount_io
from mirage.commands.builtin.utils.stream import (
    resolve_text_input as _resolve_text_input,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec.flag_view import FlagView
from mirage.types import PathSpec


def file_operand(fl: FlagView, name: str) -> PathSpec | None:
    """The path a ``--*_file`` flag names, or None when absent.

    A PATH-typed flag value reaches the command as a PathSpec (the
    executor promotes it), so ``as_str`` reads it as absent and the
    operand silently goes unread. The whole spec is returned, not its
    virtual path: a backend reader is addressed by the mount-relative
    ``vfs_path``, and only the error message wants the virtual one.

    Args:
        fl (FlagView): Flag view constructed with the command's spec.
        name (str): Canonical flag name, e.g. ``desc_file``.
    """
    paths = fl.as_paths(name)
    return paths[0] if paths else None


async def _read_file(
    opts: CommandOpts, accessor: TrelloAccessor, path: PathSpec
) -> bytes:
    """Read one ``--*_file`` operand through the mount's table.

    Args:
        opts (CommandOpts): the command's options.
        accessor (TrelloAccessor): the mount's accessor.
        path (PathSpec): the operand.
    """
    return await mount_io(opts).read_bytes(accessor, path)


async def resolve_text_input(
    accessor: TrelloAccessor,
    opts: CommandOpts,
    *,
    inline_text: str | None,
    file_path: PathSpec | None,
    error_message: str,
) -> str:
    """A card's text from its flag, its ``--*_file`` operand, or stdin.

    The operand is read through the mount's table, which hands the
    backend the rows a read of it takes, as any read on the mount is.

    Args:
        accessor (TrelloAccessor): the mount's accessor.
        opts (CommandOpts): the command's options.
        inline_text (str | None): the text given on the command line.
        file_path (PathSpec | None): the operand to read the text from.
        error_message (str): raised when nothing gives the text.
    """
    return await _resolve_text_input(
        functools.partial(_read_file, opts),
        accessor,
        inline_text=inline_text,
        file_path=file_path,
        stdin=opts.stdin,
        error_message=error_message,
    )

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

from mirage.commands.builtin.utils.stream import (
    resolve_text_input as _resolve_text_input,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.types import PathSpec
from mirage.workspace.files import Files


def file_operand(fl: FlagView, name: str) -> PathSpec | None:
    """The path a ``--*_file`` flag names, or None when absent.

    A PATH-typed flag value reaches the leaf as a PathSpec resolved
    against the session's cwd, so ``as_str`` reads it as absent and the
    operand would silently go unread.

    Args:
        fl (FlagView): Flag view constructed with the leaf's spec.
        name (str): Canonical flag name, e.g. ``desc_file``.
    """
    paths = fl.as_paths(name)
    return paths[0] if paths else None


def required_flag(fl: FlagView, name: str) -> str:
    """A flag the verb cannot run without, refused when absent or empty.

    Args:
        fl (FlagView): Flag view constructed with the leaf's spec.
        name (str): Canonical flag name, e.g. ``card_id``.
    """
    value = fl.as_str(name)
    if not value:
        raise ValueError(f"--{name} is required")
    return value


async def _read_file(flag: str, vfs: Files | None, path: PathSpec) -> bytes:
    """Read one ``--*_file`` operand through the session's files.

    Args:
        flag (str): the flag's spelling, for the refusal.
        vfs (Files | None): the session's files, None outside a workspace.
        path (PathSpec): the operand.
    """
    if vfs is None:
        raise ValueError(f"{flag} needs a workspace to read files from")
    return await vfs.read(path)


async def resolve_text_input(
    ctx: Context,
    fl: FlagView,
    *,
    value: str,
    file: str,
    error_message: str,
) -> str:
    """A card's text from its flag, its ``--*_file`` operand, or stdin.

    The operand is a workspace file the line names, read through
    ``ctx.vfs`` as any CLI reads one: it may sit on any mount the
    session can read, and no mount is the CLI's account.

    Args:
        ctx (Context): the leaf's context.
        fl (FlagView): Flag view constructed with the leaf's spec.
        value (str): the inline text flag, e.g. ``desc``.
        file (str): the file flag, e.g. ``desc_file``.
        error_message (str): raised when nothing gives the text.
    """
    return await _resolve_text_input(
        functools.partial(_read_file, f"--{file}"),
        ctx.vfs,
        inline_text=fl.as_str(value),
        file_path=file_operand(fl, file),
        stdin=ctx.stdin,
        error_message=error_message,
    )

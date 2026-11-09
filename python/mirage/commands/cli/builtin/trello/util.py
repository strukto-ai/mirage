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

from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.types import PathSpec


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


def bool_flag(fl: FlagView, name: str) -> bool | None:
    """A true/false flag, None when absent; any other value is refused.

    Args:
        fl (FlagView): Flag view constructed with the leaf's spec.
        name (str): Canonical flag name, e.g. ``closed``.
    """
    value = fl.as_str(name)
    if value is None:
        return None
    lowered = value.lower()
    if lowered in ("true", "1", "yes"):
        return True
    if lowered in ("false", "0", "no"):
        return False
    raise ValueError(f"--{name} expects true or false, got '{value}'")


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
    inline = fl.as_str(value)
    if inline is not None:
        return inline
    path = file_operand(fl, file)
    if path is not None:
        if ctx.vfs is None:
            raise ValueError(f"--{file} needs a workspace to read files from")
        return (await ctx.vfs.read(path)).decode(errors="replace")
    raw = await read_stdin_async(ctx.stdin)
    if raw is not None:
        return raw.decode(errors="replace")
    raise ValueError(error_message)

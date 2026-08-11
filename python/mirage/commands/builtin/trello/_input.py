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


from mirage.commands.builtin.utils.stream import \
    resolve_text_input as _resolve_text_input
from mirage.commands.spec.types import FlagView
from mirage.core.trello.read import read_bytes
from mirage.io.types import ByteSource
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec


def file_operand(fl: FlagView, name: str) -> PathSpec | None:
    """The path a ``--*_file`` flag names, or None when absent.

    A PATH-typed flag value reaches the command as a PathSpec (the
    executor promotes it), so ``as_str`` reads it as absent and the
    operand silently goes unread. The whole spec is returned, not its
    virtual path: a backend reader is addressed by the mount-relative
    ``resource_path``, and only the error message wants the virtual one.

    Args:
        fl (FlagView): Flag view constructed with the command's spec.
        name (str): Canonical flag name, e.g. ``desc_file``.
    """
    paths = fl.as_paths(name)
    return paths[0] if paths else None


async def _read_file(config: TrelloConfig, path: PathSpec) -> bytes:
    """Read one ``--*_file`` operand out of the trello mount.

    The core reader keys off the mount-relative path and quotes the
    virtual one in an ENOENT, so the operand has to arrive as a spec:
    handing it the virtual path makes every read miss.
    """
    return await read_bytes(config, path.resource_path, path.virtual)


async def resolve_text_input(
    config: TrelloConfig,
    *,
    inline_text: str | None,
    file_path: PathSpec | None,
    stdin: ByteSource | None,
    error_message: str,
) -> str:
    return await _resolve_text_input(_read_file,
                                     config,
                                     inline_text=inline_text,
                                     file_path=file_path,
                                     stdin=stdin,
                                     error_message=error_message)

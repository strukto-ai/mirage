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
from mirage.core.trello.read import read_bytes
from mirage.io.types import ByteSource
from mirage.resource.trello.config import TrelloConfig


async def _read_file(config: TrelloConfig, path: str) -> bytes:
    """Read one operand path with the shared (config, path) reader shape.

    The core reader also takes the virtual path, which it uses only to
    quote in an ENOENT; a ``--*-file`` operand is already virtual, so it
    is both arguments.
    """
    return await read_bytes(config, path, path)


async def resolve_text_input(
    config: TrelloConfig,
    *,
    inline_text: str | None,
    file_path: str | None,
    stdin: ByteSource | None,
    error_message: str,
) -> str:
    return await _resolve_text_input(_read_file,
                                     config,
                                     inline_text=inline_text,
                                     file_path=file_path,
                                     stdin=stdin,
                                     error_message=error_message)

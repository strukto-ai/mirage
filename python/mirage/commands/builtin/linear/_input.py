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

from collections.abc import AsyncIterator

from mirage.commands.builtin.utils.stream import \
    resolve_text_input as _resolve_text_input
from mirage.core.linear.read import read_bytes
from mirage.resource.linear.config import LinearConfig


async def resolve_text_input(
    config: LinearConfig,
    *,
    inline_text: str | None,
    file_path: str | None,
    stdin: AsyncIterator[bytes] | bytes | None,
    error_message: str,
) -> str:
    return await _resolve_text_input(read_bytes,
                                     config,
                                     inline_text=inline_text,
                                     file_path=file_path,
                                     stdin=stdin,
                                     error_message=error_message)

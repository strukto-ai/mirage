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

from collections.abc import AsyncIterator, Callable
from typing import Any

from mirage.io.types import ByteSource


async def _read_stdin_async(stdin: ByteSource | None) -> bytes | None:
    if stdin is None:
        return None
    if isinstance(stdin, bytes):
        return stdin
    chunks: list[bytes] = []
    async for chunk in stdin:
        chunks.append(chunk)
    return b"".join(chunks)


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


def _resolve_source(
    stdin: ByteSource | None,
    error_msg: str | None = None,
    error_cls: type[Exception] = ValueError,
) -> AsyncIterator[bytes]:
    if stdin is not None:
        if isinstance(stdin, bytes):
            return _wrap_bytes(stdin)
        return stdin
    if error_msg is not None:
        # error_cls picks the severity: UsageError for usage errors (exit 2),
        # the ValueError default for data/operand errors (exit 1).
        raise error_cls(error_msg)
    # GNU semantics: no stdin behaves like empty input (/dev/null)
    return _wrap_bytes(b"")


async def resolve_text_input(
    read_bytes: Callable[..., Any],
    config: object,
    *,
    inline_text: str | None,
    file_path: str | None,
    stdin: ByteSource | None,
    error_message: str,
) -> str:
    """Resolve a platform command's text from flag, file, or stdin.

    Args:
        read_bytes (Callable): backend read ``(config, path) -> bytes``.
        config: the backend config passed through to ``read_bytes``.
        inline_text (str | None): text given inline on the command line.
        file_path (str | None): path operand to read the text from.
        stdin (ByteSource | None): piped input.
        error_message (str): raised when no source provides text.
    """
    if inline_text:
        return inline_text
    if file_path:
        return (await read_bytes(config, file_path)).decode(errors="replace")
    raw = await _read_stdin_async(stdin)
    if raw is not None:
        return raw.decode(errors="replace")
    raise ValueError(error_message)

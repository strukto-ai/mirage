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

from mirage.commands.safeguard import CommandSafeguard
from mirage.io.types import ByteSource, IOResult
from mirage.types import OnExceed
from mirage.utils.stream import ensure_stream


def _trim_to_lines(buf: bytes, max_lines: int) -> bytes:
    count = 0
    for i, byte in enumerate(buf):
        if byte == 0x0A:
            count += 1
            if count == max_lines:
                return buf[:i + 1]
    return buf


def _build_notice(safeguard: CommandSafeguard) -> bytes:
    parts: list[str] = []
    if safeguard.max_lines is not None:
        parts.append(f"{safeguard.max_lines} lines")
    if safeguard.max_bytes is not None:
        parts.append(f"{safeguard.max_bytes} bytes")
    limit = " / ".join(parts)
    return (f"output truncated at safeguard limit ({limit}); "
            "narrow with grep, or read more with head -n / tail -n / "
            "a more specific path\n").encode()


async def apply_safeguard(
    src: ByteSource,
    safeguard: CommandSafeguard | None,
) -> tuple[ByteSource | None, IOResult]:
    if safeguard is None:
        return src, IOResult()
    max_lines = safeguard.max_lines
    max_bytes = safeguard.max_bytes
    if max_lines is None and max_bytes is None:
        return src, IOResult()
    buf = bytearray()
    truncated = False
    async for chunk in ensure_stream(src):
        buf.extend(chunk)
        if max_bytes is not None and len(buf) > max_bytes:
            buf = bytearray(buf[:max_bytes])
            truncated = True
            break
        if max_lines is not None and buf.count(b"\n") >= max_lines:
            buf = bytearray(_trim_to_lines(bytes(buf), max_lines))
            truncated = True
            break
    data = bytes(buf)
    if not truncated:
        return data, IOResult()
    notice = _build_notice(safeguard)
    if safeguard.on_exceed is OnExceed.ERROR:
        return None, IOResult(exit_code=1, stderr=notice)
    return data, IOResult(stderr=notice)

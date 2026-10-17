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

from mirage.commands.builtin.constants import FILE_MIME_MAP, MAGIC_SIGNATURES
from mirage.types import ContentType, FileStat, FileType


def format_file_result(
    path: str,
    result: ContentType | FileType | str,
    brief: bool,
    mime: bool,
) -> str:
    """Render one ``file`` output line.

    Args:
        path (str): operand as typed, omitted under -b.
        result (ContentType | FileType | str): detected type, or a ready
            description.
        brief (bool): -b, drop the filename column.
        mime (bool): -i, map the type to its MIME spelling.
    """
    key = (
        result.value
        if isinstance(result, (ContentType, FileType))
        else str(result)
    )
    desc = FILE_MIME_MAP.get(key, key) if mime else key
    if brief:
        return desc
    return f"{path}: {desc}"


def detect_file_type(
    path: str, header: bytes, s: FileStat
) -> ContentType | str:
    if s.content is not None and s.content != ContentType.BINARY:
        return s.content
    for sig, ftype in MAGIC_SIGNATURES:
        if header.startswith(sig):
            return ftype
    if all(b < 128 for b in header[:256] if b != 0):
        return ContentType.TEXT
    return ContentType.BINARY

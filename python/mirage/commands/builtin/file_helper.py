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

from mirage.types import FileStat, FileType


def _detect(path: str, header: bytes, s: FileStat) -> FileType | str:
    if s.type and s.type != FileType.BINARY:
        return s.type
    magic: list[tuple[bytes, FileType]] = [
        (b"\x89PNG", FileType.IMAGE_PNG),
        (b"\xff\xd8\xff", FileType.IMAGE_JPEG),
        (b"GIF8", FileType.IMAGE_GIF),
        (b"PK\x03\x04", FileType.ZIP),
        (b"\x1f\x8b", FileType.GZIP),
        (b"%PDF", FileType.PDF),
        (b"{\n", FileType.JSON),
        (b"[{", FileType.JSON),
    ]
    for sig, ftype in magic:
        if header.startswith(sig):
            return ftype
    if all(b < 128 for b in header[:256] if b != 0):
        return FileType.TEXT
    return FileType.BINARY

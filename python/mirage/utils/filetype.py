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

from mirage.types import FileType

EXTENSION_MAP: dict[str, FileType] = {
    "json": FileType.JSON,
    "jsonl": FileType.JSON,
    "csv": FileType.CSV,
    "tsv": FileType.CSV,
    "txt": FileType.TEXT,
    "md": FileType.TEXT,
    "py": FileType.TEXT,
    "js": FileType.TEXT,
    "ts": FileType.TEXT,
    "yaml": FileType.TEXT,
    "yml": FileType.TEXT,
    "toml": FileType.TEXT,
    "png": FileType.IMAGE_PNG,
    "jpg": FileType.IMAGE_JPEG,
    "jpeg": FileType.IMAGE_JPEG,
    "gif": FileType.IMAGE_GIF,
    "zip": FileType.ZIP,
    "gz": FileType.GZIP,
    "pdf": FileType.PDF,
}

DEFAULT_TYPE = FileType.BINARY

_MIMETYPE_MAP: dict[str, FileType] = {
    "application/pdf": FileType.PDF,
    "application/zip": FileType.ZIP,
    "application/gzip": FileType.GZIP,
    "application/json": FileType.JSON,
    "image/png": FileType.IMAGE_PNG,
    "image/jpeg": FileType.IMAGE_JPEG,
    "image/gif": FileType.IMAGE_GIF,
    "text/csv": FileType.CSV,
}


def guess_type(path: str) -> FileType:
    """Return the file type for *path* based on its extension.

    Args:
        path (str): file path or name.

    Returns:
        FileType: matched type from EXTENSION_MAP, or DEFAULT_TYPE.
    """
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return EXTENSION_MAP.get(ext, DEFAULT_TYPE)


def filetype_from_mimetype(mime: str) -> FileType:
    """Map a standard mimetype string to a FileType.

    Args:
        mime (str): mimetype string (e.g., "image/png", "application/pdf").

    Returns:
        FileType: matched type, TEXT for any text/*, or BINARY default.
    """
    if not mime:
        return FileType.BINARY
    if mime in _MIMETYPE_MAP:
        return _MIMETYPE_MAP[mime]
    if mime.startswith("text/"):
        return FileType.TEXT
    return FileType.BINARY

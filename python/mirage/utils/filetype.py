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
    "log": FileType.TEXT,
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
    "gzip": FileType.GZIP,
    "pdf": FileType.PDF,
}

DEFAULT_TYPE = FileType.BINARY

# Extension-guessed like upstream mailers' mime_guess, as a deliberate
# fixed subset: the stdlib mimetypes module consults platform tables,
# and the python and TypeScript implementations must guess identically
# for serialized bytes to match. Anything else is
# application/octet-stream, which every client treats as "download me".
MIME_BY_EXTENSION: dict[str, str] = {
    "csv": "text/csv",
    "gif": "image/gif",
    "gz": "application/gzip",
    "htm": "text/html",
    "html": "text/html",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "json": "application/json",
    "md": "text/markdown",
    "pdf": "application/pdf",
    "png": "image/png",
    "svg": "image/svg+xml",
    "tar": "application/x-tar",
    "txt": "text/plain",
    "xml": "text/xml",
    "zip": "application/zip",
}

OCTET_STREAM = "application/octet-stream"


def mime_type_for(filename: str) -> str:
    """Guess a MIME content type from the filename's extension.

    Args:
        filename (str): a file's basename.
    """
    _, dot, extension = filename.rpartition(".")
    if not dot:
        return OCTET_STREAM
    return MIME_BY_EXTENSION.get(extension.lower(), OCTET_STREAM)


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


IMAGE_TYPE_BY_EXTENSION: dict[str, FileType] = {
    "png": FileType.IMAGE_PNG,
    "jpg": FileType.IMAGE_JPEG,
    "jpeg": FileType.IMAGE_JPEG,
    "gif": FileType.IMAGE_GIF,
}


def image_type_for_extension(ext: str) -> FileType:
    """Return the FileType for a bare image extension.

    Args:
        ext (str): extension without the dot (e.g. ``png``).

    Returns:
        FileType: matched image type, or BINARY for anything else.
    """
    return IMAGE_TYPE_BY_EXTENSION.get(ext.lower(), FileType.BINARY)


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

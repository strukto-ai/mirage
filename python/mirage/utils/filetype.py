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

from mirage.types import ContentType

# The rendering hint by extension, what `content_type_for_path` answers
# for a file whose backend knows nothing better. Mirrors
# CONTENT_BY_EXTENSION in utils/filetype.ts; the shared fixture
# integ/fixtures/filetype/tables.json pins both.
CONTENT_BY_EXTENSION: dict[str, ContentType] = {
    "json": ContentType.JSON,
    "jsonl": ContentType.JSON,
    "csv": ContentType.CSV,
    "tsv": ContentType.CSV,
    "txt": ContentType.TEXT,
    "md": ContentType.TEXT,
    "log": ContentType.TEXT,
    "py": ContentType.TEXT,
    "js": ContentType.TEXT,
    "ts": ContentType.TEXT,
    "yaml": ContentType.TEXT,
    "yml": ContentType.TEXT,
    "toml": ContentType.TEXT,
    "png": ContentType.IMAGE_PNG,
    "jpg": ContentType.IMAGE_JPEG,
    "jpeg": ContentType.IMAGE_JPEG,
    "gif": ContentType.IMAGE_GIF,
    "zip": ContentType.ZIP,
    "gz": ContentType.GZIP,
    "gzip": ContentType.GZIP,
    "pdf": ContentType.PDF,
}

# A MIME type's rendering hint, for a backend whose API reports one
# (slack and discord attachments). Anything else under text/ is TEXT and
# the rest is BINARY.
CONTENT_BY_MIME: dict[str, ContentType] = {
    "application/pdf": ContentType.PDF,
    "application/zip": ContentType.ZIP,
    "application/gzip": ContentType.GZIP,
    "application/json": ContentType.JSON,
    "image/png": ContentType.IMAGE_PNG,
    "image/jpeg": ContentType.IMAGE_JPEG,
    "image/gif": ContentType.IMAGE_GIF,
    "text/csv": ContentType.CSV,
}

# The wire MIME type by extension, what a mail builder puts in an
# attachment's Content-Type. Extension-guessed like upstream mailers'
# mime_guess, as a deliberate fixed subset: the stdlib mimetypes module
# consults platform tables, and the python and TypeScript implementations
# must guess identically for serialized bytes to match. Anything else is
# application/octet-stream, which every client treats as "download me".
# Separate from CONTENT_BY_EXTENSION on purpose: that table is a rendering
# hint and may grow freely, this one is pinned to the bytes himalaya sends.
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


def _extension_of(path: str) -> str:
    """The lower-cased extension of a path's last segment, "" for none.

    Args:
        path (str): a file path or bare name.
    """
    name = path.rpartition("/")[2]
    _, dot, extension = name.rpartition(".")
    return extension.lower() if dot else ""


def content_type_for_extension(ext: str) -> ContentType:
    """The rendering hint for a bare extension, BINARY for an unknown one.

    Args:
        ext (str): extension without the dot (e.g. ``png``).
    """
    return CONTENT_BY_EXTENSION.get(ext.lower(), ContentType.BINARY)


def content_type_for_path(path: str) -> ContentType:
    """The rendering hint for a path, from its extension.

    Args:
        path (str): file path or name.
    """
    return content_type_for_extension(_extension_of(path))


def content_type_for_mime(mime: str) -> ContentType:
    """The rendering hint for a MIME type.

    Args:
        mime (str): a MIME type (e.g. ``image/png``); "" when unknown.

    Returns:
        ContentType: the table's answer, TEXT for any other text/*, else
        BINARY.
    """
    mapped = CONTENT_BY_MIME.get(mime)
    if mapped is not None:
        return mapped
    if mime.startswith("text/"):
        return ContentType.TEXT
    return ContentType.BINARY


def mime_type_for(filename: str) -> str:
    """The wire MIME type for a filename, from the fixed table.

    Args:
        filename (str): a file's basename.
    """
    ext = _extension_of(filename)
    if not ext:
        return OCTET_STREAM
    return MIME_BY_EXTENSION.get(ext, OCTET_STREAM)

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

from typing import Any

import aiohttp

from mirage.accessor.notion import NotionAccessor
from mirage.core.notion.client import notion_get, notion_post
from mirage.types import JsonValue


async def create_file_upload(
    accessor: NotionAccessor, body: dict[str, JsonValue]
) -> dict[str, Any]:
    """Open a file upload.

    Args:
        accessor (NotionAccessor): the install's accessor.
        body (dict[str, JsonValue]): the upload's mode and metadata.
    """
    return await notion_post(accessor, "/file_uploads", body)


async def send_file_part(
    accessor: NotionAccessor,
    upload_id: str,
    filename: str,
    content_type: str,
    data: bytes,
    part_number: int,
) -> dict[str, Any]:
    """Send one part of a multi-part upload.

    Args:
        accessor (NotionAccessor): the install's accessor.
        upload_id (str): the upload's id.
        filename (str): the file's name.
        content_type (str): the file's MIME type.
        data (bytes): this part's bytes.
        part_number (int): the part's 1-based position.
    """
    # aiohttp's default percent-encodes a whole file name, spaces included.
    # Escaping only what fetch's FormData escapes puts the same name on the
    # wire from both hosts.
    form = aiohttp.FormData(quote_fields=False)
    form.add_field(
        "file",
        data,
        filename=filename.replace("\n", "%0A")
        .replace("\r", "%0D")
        .replace('"', "%22"),
        content_type=content_type,
    )
    form.add_field("part_number", str(part_number))
    return await notion_post(
        accessor, f"/file_uploads/{upload_id}/send", form=form
    )


async def complete_file_upload(
    accessor: NotionAccessor, upload_id: str
) -> dict[str, Any]:
    """Close a multi-part upload once every part has been sent.

    Args:
        accessor (NotionAccessor): the install's accessor.
        upload_id (str): the upload's id.
    """
    return await notion_post(accessor, f"/file_uploads/{upload_id}/complete")


async def get_file_upload(
    accessor: NotionAccessor, upload_id: str
) -> dict[str, Any]:
    """Retrieve one file upload.

    Args:
        accessor (NotionAccessor): the install's accessor.
        upload_id (str): the upload's id.
    """
    return await notion_get(accessor, f"/file_uploads/{upload_id}")


async def list_file_uploads(accessor: NotionAccessor) -> dict[str, Any]:
    """The first page of the integration's file uploads.

    Args:
        accessor (NotionAccessor): the install's accessor.
    """
    return await notion_get(accessor, "/file_uploads")

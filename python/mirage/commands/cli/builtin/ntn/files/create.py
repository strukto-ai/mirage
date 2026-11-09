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

from mirage.accessor.notion import NotionAccessor
from mirage.commands.cli.builtin.ntn.api import refusal
from mirage.commands.cli.builtin.ntn.util import (
    notion_transport,
    upload_output,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.notion.file_uploads import (
    complete_file_upload,
    create_file_upload,
    send_file_part,
)
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import JsonValue, PathSpec
from mirage.utils.filetype import mime_type_for

DEFAULT_FILENAME = "upload.bin"
PART_SIZE = 10 * 1024 * 1024
NO_BYTES = (
    "error: No file bytes were received on stdin.\n"
    "  hint: Redirect a file, for example: "
    "`ntn files create < file.png`.\n"
)


def _external_name(url: str) -> str:
    """The file name an external URL's path ends in.

    Args:
        url (str): the URL as typed.
    """
    path = url.split("://", 1)[-1].partition("/")[2]
    name = path.split("?", 1)[0].split("#", 1)[0].rsplit("/", 1)[-1]
    return name or DEFAULT_FILENAME


async def files_create(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    line = notion_transport(accessor, ctx)
    named = fl.as_str("filename")
    content_type = fl.as_str("content_type")
    external = fl.as_str("external_url")
    as_json = fl.as_bool("json")
    if external is not None:
        name = named or _external_name(external)
        body: dict[str, JsonValue] = {
            "mode": "external_url",
            "external_url": external,
            "filename": name,
            "content_type": content_type or mime_type_for(name),
        }
        opened = await create_file_upload(line, body)
        return upload_output(opened, as_json), IOResult()
    data = await materialize(ctx.stdin)
    if not data:
        return refusal(NO_BYTES, 5)
    name = named or DEFAULT_FILENAME
    kind = content_type or mime_type_for(name)
    parts = (len(data) + PART_SIZE - 1) // PART_SIZE
    opened = await create_file_upload(
        line,
        {
            "mode": "multi_part",
            "filename": name,
            "content_type": kind,
            "number_of_parts": parts,
        },
    )
    upload_id = str(opened["id"])
    for index in range(parts):
        chunk = data[index * PART_SIZE : (index + 1) * PART_SIZE]
        await send_file_part(line, upload_id, name, kind, chunk, index + 1)
    done = await complete_file_upload(line, upload_id)
    return upload_output(done, as_json), IOResult()

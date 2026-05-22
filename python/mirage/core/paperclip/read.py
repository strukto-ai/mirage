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

from mirage.accessor.paperclip import PaperclipAccessor
from mirage.cache.index import IndexCacheStore
from mirage.types import PathSpec

VALID_SOURCES = ["arxiv", "biorxiv", "medrxiv", "pmc"]


async def read(
    accessor: PaperclipAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    """Read file content from the Paperclip virtual filesystem.

    Args:
        accessor (PaperclipAccessor): The Paperclip accessor instance.
        path (PathSpec): Virtual path to read.
        index (IndexCacheStore): Optional index cache store.

    Returns:
        bytes: File content encoded as UTF-8.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original

    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    parts = key.split("/")

    if not parts or parts[0] not in VALID_SOURCES:
        raise FileNotFoundError(key)

    if len(parts) < 5:
        raise FileNotFoundError(key)

    paper_id = parts[3]
    file_subpath = "/".join(parts[4:])
    result = await accessor.execute("cat",
                                    f"/papers/{paper_id}/{file_subpath}")
    output = result["output"]
    return output.encode("utf-8")

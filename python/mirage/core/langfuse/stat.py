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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, FileType, PathSpec

TOP_LEVEL_DIRS = {"traces", "sessions", "prompts", "datasets"}


async def stat(
    accessor: LangfuseAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> FileStat:
    """Get file stat for a path.

    Args:
        accessor (LangfuseAccessor): langfuse accessor.
        path (str): resource-relative path.
        index (IndexCacheStore | None): index cache.
        prefix (str): mount prefix for virtual index keys.
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

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if any(p.startswith(".") for p in parts):
        raise FileNotFoundError(path)

    if len(parts) == 1 and parts[0] in TOP_LEVEL_DIRS:
        return FileStat(name=parts[0], type=FileType.DIRECTORY)

    if parts[0] == "traces" and len(parts) == 2 and parts[1].endswith(".json"):
        return FileStat(name=parts[1], type=FileType.JSON)

    if parts[0] == "sessions" and len(parts) == 2:
        return FileStat(
            name=parts[1],
            type=FileType.DIRECTORY,
            extra={"session_id": parts[1]},
        )

    if (parts[0] == "sessions" and len(parts) == 3
            and parts[2].endswith(".json")):
        return FileStat(name=parts[2], type=FileType.JSON)

    if parts[0] == "prompts" and len(parts) == 2:
        return FileStat(
            name=parts[1],
            type=FileType.DIRECTORY,
            extra={"prompt_name": parts[1]},
        )

    if (parts[0] == "prompts" and len(parts) == 3
            and parts[2].endswith(".json")):
        return FileStat(name=parts[2], type=FileType.JSON)

    if parts[0] == "datasets" and len(parts) == 2:
        return FileStat(
            name=parts[1],
            type=FileType.DIRECTORY,
            extra={"dataset_name": parts[1]},
        )

    if (parts[0] == "datasets" and len(parts) == 3
            and parts[2] == "items.jsonl"):
        return FileStat(name="items.jsonl", type=FileType.TEXT)

    if parts[0] == "datasets" and len(parts) == 3 and parts[2] == "runs":
        return FileStat(name="runs", type=FileType.DIRECTORY)

    if (parts[0] == "datasets" and len(parts) == 4 and parts[2] == "runs"
            and parts[3].endswith(".jsonl")):
        return FileStat(name=parts[3], type=FileType.TEXT)

    raise FileNotFoundError(path)

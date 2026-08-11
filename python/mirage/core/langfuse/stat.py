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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.langfuse.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

TOP_LEVEL_DIRS = {"traces", "sessions", "prompts", "datasets"}


def basename_of(entry: str) -> str:
    return entry.rstrip("/").rsplit("/", 1)[-1]


async def assert_listed(
    accessor: LangfuseAccessor,
    path: PathSpec,
    prefix: str,
    index: IndexCacheStore,
) -> None:
    """Raise ENOENT unless the path appears in its parent's listing.

    Every path shape langfuse serves is recognizable from the path text alone,
    but a recognizable shape is not evidence that the trace, prompt, dataset or
    run behind it exists. The parent listing is index-cached, so validating
    costs one listing per directory rather than one API call per stat.

    Args:
        accessor (LangfuseAccessor): langfuse accessor.
        path (PathSpec): resource-relative path being stat'd.
        prefix (str): mount prefix for virtual index keys.
        index (IndexCacheStore): index cache.

    Raises:
        FileNotFoundError: the entry is absent from its parent listing.
    """
    parent_virtual = path.virtual.rstrip("/").rsplit("/", 1)[0] or "/"
    entries = await readdir(
        accessor,
        PathSpec(virtual=parent_virtual,
                 directory=parent_virtual,
                 resource_path=mount_key(parent_virtual, prefix)),
        index,
    )
    if basename_of(path.resource_path) not in {
            basename_of(entry)
            for entry in entries
    }:
        raise enoent(path.virtual)


async def listed_size(
    index: IndexCacheStore,
    path: PathSpec,
    prefix: str,
) -> int | None:
    """Return the size the parent listing recorded for this path.

    Args:
        index (IndexCacheStore): index cache.
        path (PathSpec): resource-relative path being stat'd.
        prefix (str): mount prefix for virtual index keys.
    """
    # assert_listed has just populated the parent directory, so any size the
    # listing computed is already in the index.
    lookup = await index.get(prefix + "/" + path.resource_path)
    return lookup.entry.size if lookup.entry is not None else None


async def stat(
    accessor: LangfuseAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Get file stat for a path.

    Args:
        accessor (LangfuseAccessor): langfuse accessor.
        path (str): resource-relative path.
        index (IndexCacheStore): index cache.
        prefix (str): mount prefix for virtual index keys.
    """
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if any(p.startswith(".") for p in parts):
        raise enoent(virtual)

    if len(parts) == 1 and parts[0] in TOP_LEVEL_DIRS:
        return FileStat(name=parts[0], type=FileType.DIRECTORY)

    if parts[0] == "traces" and len(parts) == 2 and parts[1].endswith(".json"):
        await assert_listed(accessor, path, prefix, index)
        return FileStat(name=parts[1], type=FileType.JSON)

    if parts[0] == "sessions" and len(parts) == 2:
        await assert_listed(accessor, path, prefix, index)
        return FileStat(
            name=parts[1],
            type=FileType.DIRECTORY,
            extra={"session_id": parts[1]},
        )

    if (parts[0] == "sessions" and len(parts) == 3
            and parts[2].endswith(".json")):
        await assert_listed(accessor, path, prefix, index)
        return FileStat(name=parts[2], type=FileType.JSON)

    if parts[0] == "prompts" and len(parts) == 2:
        await assert_listed(accessor, path, prefix, index)
        return FileStat(
            name=parts[1],
            type=FileType.DIRECTORY,
            extra={"prompt_name": parts[1]},
        )

    if (parts[0] == "prompts" and len(parts) == 3
            and parts[2].endswith(".json")):
        await assert_listed(accessor, path, prefix, index)
        return FileStat(name=parts[2], type=FileType.JSON)

    if parts[0] == "datasets" and len(parts) == 2:
        await assert_listed(accessor, path, prefix, index)
        return FileStat(
            name=parts[1],
            type=FileType.DIRECTORY,
            extra={"dataset_name": parts[1]},
        )

    if (parts[0] == "datasets" and len(parts) == 3
            and parts[2] == "items.jsonl"):
        await assert_listed(accessor, path, prefix, index)
        return FileStat(
            name="items.jsonl",
            size=await listed_size(index, path, prefix),
            type=FileType.TEXT,
        )

    if parts[0] == "datasets" and len(parts) == 3 and parts[2] == "runs":
        await assert_listed(accessor, path, prefix, index)
        return FileStat(name="runs", type=FileType.DIRECTORY)

    if (parts[0] == "datasets" and len(parts) == 4 and parts[2] == "runs"
            and parts[3].endswith(".jsonl")):
        await assert_listed(accessor, path, prefix, index)
        return FileStat(
            name=parts[3],
            size=await listed_size(index, path, prefix),
            type=FileType.TEXT,
        )

    raise enoent(virtual)

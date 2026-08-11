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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.jaeger._client import is_trace_id
from mirage.core.jaeger.readdir import assert_service, readdir
from mirage.core.jaeger.scope import OPERATIONS_FILE, detect_scope
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


async def _assert_listed(
    accessor: JaegerAccessor,
    path: PathSpec,
    index: IndexCacheStore,
) -> None:
    """Raise ENOENT unless the path appears in its parent's listing.

    Every path shape jaeger serves is recognizable from the text alone, but a
    recognizable shape is not evidence the trace exists. The parent listing is
    index-cached, so this costs one listing per directory rather than one API
    call per stat.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        path (PathSpec): path being stat'd.
        index (IndexCacheStore): index cache.

    Raises:
        FileNotFoundError: the entry is absent from its parent listing.
    """
    virtual = path.virtual.rstrip("/")
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    parent_virtual = virtual.rsplit("/", 1)[0] or "/"
    parent_resource = parent_virtual
    if prefix and parent_virtual.startswith(prefix):
        parent_resource = parent_virtual[len(prefix):]
    entries = await readdir(
        accessor,
        PathSpec(resource_path=parent_resource.strip("/"),
                 virtual=parent_virtual,
                 directory=parent_virtual),
        index,
    )
    names = {entry.rstrip("/").rsplit("/", 1)[-1] for entry in entries}
    if path.resource_path.rstrip("/").rsplit("/", 1)[-1] not in names:
        raise enoent(virtual)


async def stat(
    accessor: JaegerAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Get file stat for a path.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        path (PathSpec): resource-relative path.
        index (IndexCacheStore): index cache.

    Returns:
        FileStat: stat for the path.

    Raises:
        FileNotFoundError: the path is not a jaeger entry.
    """
    virtual = path.virtual
    key = path.resource_path

    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)

    if any(p.startswith(".") for p in key.split("/")):
        raise enoent(virtual)

    scope = detect_scope(path)

    if scope.level == "services":
        return FileStat(name="services", type=FileType.DIRECTORY)

    if scope.level == "service":
        assert scope.service is not None
        await assert_service(accessor, scope.service, virtual)
        return FileStat(
            name=scope.service,
            type=FileType.DIRECTORY,
            extra={"service": scope.service},
        )

    if scope.level == "traces":
        assert scope.service is not None
        await assert_service(accessor, scope.service, virtual)
        return FileStat(name="traces", type=FileType.DIRECTORY)

    if scope.level == "operations":
        assert scope.service is not None
        # The service readdir stores the rendered document's byte length, so
        # the listing that just proved existence also carries the size.
        await _assert_listed(accessor, path, index)
        lookup = await index.get(path.virtual.rstrip("/"))
        return FileStat(
            name=OPERATIONS_FILE,
            type=FileType.JSON,
            size=lookup.entry.size if lookup.entry is not None else None,
        )

    if scope.level == "trace":
        assert scope.trace_id is not None
        if not is_trace_id(scope.trace_id):
            raise enoent(virtual)
        await _assert_listed(accessor, path, index)
        # The traces readdir stores the rendered document's byte length, so
        # the listing that just proved existence also carries the size.
        lookup = await index.get(path.virtual.rstrip("/"))
        return FileStat(
            name=f"{scope.trace_id}.json",
            type=FileType.JSON,
            size=lookup.entry.size if lookup.entry is not None else None,
            extra={"trace_id": scope.trace_id},
        )

    raise enoent(virtual)

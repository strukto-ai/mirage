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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.jaeger._client import (fetch_operations, fetch_services,
                                        fetch_traces, is_trace_id)
from mirage.core.jaeger.render import jaeger_json_bytes
from mirage.core.jaeger.scope import (OPERATIONS_FILE, TOP_LEVEL_DIRS,
                                      detect_scope)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


async def readdir(
    accessor: JaegerAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """List directory contents.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        path_spec (PathSpec): resource-relative path.
        index (IndexCacheStore): index cache.

    Returns:
        list[str]: virtual child paths.

    Raises:
        FileNotFoundError: the path is not a jaeger directory.
    """
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")

    if key and any(p.startswith(".") for p in key.split("/")):
        raise enoent(virtual)

    virtual_key = prefix + "/" + key if key else prefix or "/"
    scope = detect_scope(path)

    if scope.level == "root":
        return [f"{prefix}/{d}" for d in TOP_LEVEL_DIRS]

    if scope.level == "services":
        return await _readdir_services(accessor, virtual_key, index, prefix)

    if scope.level == "service":
        assert scope.service is not None
        await assert_service(accessor, scope.service, virtual)
        return await _readdir_service(accessor, scope.service, virtual_key,
                                      index, prefix)

    if scope.level == "traces":
        assert scope.service is not None
        await assert_service(accessor, scope.service, virtual)
        return await _readdir_traces(accessor, scope.service, virtual_key,
                                     index, prefix)

    raise enoent(virtual)


async def assert_service(accessor: JaegerAccessor, service: str,
                         virtual: str) -> None:
    """Raise ENOENT unless the service is known to Jaeger.

    The operations endpoint answers 200 with an empty list for a service that
    was never seen, so an unknown service would otherwise look like an empty
    directory instead of a missing one.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        service (str): service name to check.
        virtual (str): virtual path named in the ENOENT message.

    Raises:
        FileNotFoundError: the service is unknown.
    """
    services = await fetch_services(accessor)
    if service not in services:
        raise enoent(virtual)


async def _readdir_service(
    accessor: JaegerAccessor,
    service: str,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    # One operations call per service directory actually entered: nothing in
    # the services listing carries operation names, so operations.json can
    # only be sized here, and only for services the caller opens.
    operations = await fetch_operations(accessor, service)
    entries = [
        (OPERATIONS_FILE,
         IndexEntry(
             id=f"{service}/operations",
             name=OPERATIONS_FILE,
             resource_type="jaeger/operations",
             vfs_name=OPERATIONS_FILE,
             size=len(jaeger_json_bytes(operations)),
         )),
        ("traces",
         IndexEntry(
             id=f"{service}/traces",
             name="traces",
             resource_type="jaeger/traces_dir",
             vfs_name="traces",
         )),
    ]
    await index.set_dir(virtual_key, entries)
    return [f"{prefix}/services/{service}/{name}" for name, _ in entries]


async def _readdir_services(
    accessor: JaegerAccessor,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    services = await fetch_services(accessor)
    entries = []
    names = []
    for service in services:
        entry = IndexEntry(
            id=service,
            name=service,
            resource_type="jaeger/service",
            vfs_name=service,
        )
        entries.append((service, entry))
        names.append(f"{prefix}/services/{service}")
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_traces(
    accessor: JaegerAccessor,
    service: str,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    traces = await fetch_traces(
        accessor,
        service,
        limit=accessor.config.default_trace_limit,
        from_timestamp=accessor.config.default_from_timestamp,
        to_timestamp=accessor.config.default_to_timestamp,
    )
    entries = []
    names = []
    for trace in traces:
        trace_id = str(trace.get("traceID", ""))
        if not is_trace_id(trace_id):
            continue
        filename = f"{trace_id}.json"
        # The search endpoint returns complete trace documents, so the
        # rendered size is free here. Span order may differ from the by-id
        # fetch, but reordering the same spans leaves the byte length equal.
        entry = IndexEntry(
            id=trace_id,
            name=trace_id,
            resource_type="jaeger/trace",
            vfs_name=filename,
            size=len(jaeger_json_bytes(trace)),
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/services/{service}/traces/{filename}")
    await index.set_dir(virtual_key, entries)
    return names

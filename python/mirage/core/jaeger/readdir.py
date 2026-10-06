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
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import DirListing, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.jaeger.client import (
    fetch_operations,
    fetch_services,
    fetch_traces,
    is_trace_id,
)
from mirage.core.jaeger.scope import (
    OPERATIONS_FILE,
    TOP_LEVEL_DIRS,
    detect_scope,
)
from mirage.core.render.json import json_bytes
from mirage.errors.fs import enoent


async def assert_service(
    accessor: JaegerAccessor, service: str, virtual: str
) -> None:
    """Raise ENOENT unless the service is known to Jaeger.

    The operations endpoint answers 200 with an empty list for a service
    that was never seen, so an unknown service would otherwise look like
    an empty directory instead of a missing one.

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


async def service_guard(
    accessor: JaegerAccessor, match: ScopeMatch, virtual: str
) -> None:
    await assert_service(accessor, match.slots["service"], virtual)


async def _list_services(
    accessor: JaegerAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    services = await fetch_services(accessor)
    return [
        (
            service,
            IndexEntry(
                id=service,
                name=service,
                resource_type="jaeger/service",
                vfs_name=service,
            ),
        )
        for service in services
    ]


async def _list_service(
    accessor: JaegerAccessor, match: ScopeMatch
) -> list[tuple[str, IndexEntry]]:
    service = match.slots["service"]
    # One operations call per service directory actually entered: nothing
    # in the services listing carries operation names, so operations.json
    # can only be sized here, and only for services the caller opens.
    operations = await fetch_operations(accessor, service)
    return [
        (
            OPERATIONS_FILE,
            IndexEntry(
                id=f"{service}/operations",
                name=OPERATIONS_FILE,
                resource_type="jaeger/operations",
                vfs_name=OPERATIONS_FILE,
                size=len(json_bytes(operations)),
            ),
        ),
        (
            "traces",
            IndexEntry(
                id=f"{service}/traces",
                name="traces",
                resource_type="jaeger/traces_dir",
                vfs_name="traces",
            ),
        ),
    ]


async def _list_traces(
    accessor: JaegerAccessor, match: ScopeMatch
) -> DirListing:
    service = match.slots["service"]
    traces = await fetch_traces(
        accessor,
        service,
        limit=accessor.config.default_trace_limit,
        from_timestamp=accessor.config.default_from_timestamp,
        to_timestamp=accessor.config.default_to_timestamp,
    )
    entries: list[tuple[str, IndexEntry]] = []
    for trace in traces:
        trace_id = str(trace.get("traceID", ""))
        if not is_trace_id(trace_id):
            continue
        filename = f"{trace_id}.json"
        # The search endpoint returns complete trace documents, so the
        # rendered size is free here. Span order may differ from the
        # by-id fetch, but reordering the same spans leaves the byte
        # length equal.
        entry = IndexEntry(
            id=trace_id,
            name=trace_id,
            resource_type="jaeger/trace",
            vfs_name=filename,
            size=len(json_bytes(trace)),
        )
        entries.append((filename, entry))
    # The newest default_trace_limit traces: one that ages out of the page
    # is still in Jaeger, so the listing evicts nothing.
    return DirListing(entries=entries, window=True)


readdir = make_readdir(
    detect_scope,
    listers={
        "services": _list_services,
        "service": _list_service,
        "traces": _list_traces,
    },
    static_root=tuple(TOP_LEVEL_DIRS),
    guards={
        "service": service_guard,
        "traces": service_guard,
    },
)

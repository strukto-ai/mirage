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

from mirage.accessor.jaeger import JaegerAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.jaeger.client import (
    JaegerApiError,
    fetch_operations,
    fetch_trace,
)
from mirage.core.jaeger.readdir import assert_service
from mirage.core.jaeger.scope import detect_scope
from mirage.core.render.json import json_bytes
from mirage.errors.fs import enoent
from mirage.types import PathSpec


def _has_service(trace: dict[str, Any], service: str) -> bool:
    """Report whether any span in the trace was emitted by the service.

    A trace is fetched by id from the global endpoint, so the id alone
    does not place it under the service directory it was addressed
    through. Membership is read from the trace's own process table
    rather than the service listing, which is windowed and limited and
    would hide a trace that really belongs.

    Args:
        trace (dict[str, Any]): trace document from the API.
        service (str): service name the path addressed.

    Returns:
        bool: True when the service emitted at least one span.
    """
    processes = trace.get("processes")
    if not isinstance(processes, dict):
        return False
    return any(
        isinstance(p, dict) and p.get("serviceName") == service
        for p in processes.values()
    )


async def _read_operations(
    accessor: JaegerAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    service = match.slots["service"]
    await assert_service(accessor, service, path.virtual)
    operations = await fetch_operations(accessor, service)
    return json_bytes(operations)


async def _read_trace(
    accessor: JaegerAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    service = match.slots["service"]
    await assert_service(accessor, service, path.virtual)
    try:
        trace = await fetch_trace(accessor, match.slots["trace_id"])
    except JaegerApiError as exc:
        if exc.status_code == 404:
            raise enoent(path.virtual) from exc
        raise
    # Reading by id would otherwise serve any trace through any service
    # directory, contradicting stat and ls for the same path.
    if not _has_service(trace, service):
        raise enoent(path.virtual)
    return json_bytes(trace)


read = make_read(
    detect_scope,
    {
        "operations": _read_operations,
        "trace": _read_trace,
    },
)

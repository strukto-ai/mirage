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

import json
from typing import Any

from mirage.accessor.jaeger import JaegerAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.jaeger._client import (JaegerApiError, fetch_operations,
                                        fetch_trace, is_trace_id)
from mirage.core.jaeger.readdir import assert_service
from mirage.core.jaeger.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode()


async def read(
    accessor: JaegerAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    """Read a file as bytes.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        path (PathSpec): resource-relative path.
        index (IndexCacheStore): index cache.

    Returns:
        bytes: rendered file content.

    Raises:
        FileNotFoundError: the path is not a jaeger file.
    """
    virtual = path.virtual
    key = path.resource_path

    if any(p.startswith(".") for p in key.split("/")):
        raise enoent(virtual)

    scope = detect_scope(path)

    if scope.level == "operations":
        assert scope.service is not None
        await assert_service(accessor, scope.service, virtual)
        operations = await fetch_operations(accessor, scope.service)
        return _json_bytes(operations)

    if scope.level == "trace":
        assert scope.trace_id is not None
        # A malformed id cannot name an existing trace, so it is ENOENT rather
        # than the API's 400 "invalid length for TraceID".
        if not is_trace_id(scope.trace_id):
            raise enoent(virtual)
        try:
            trace = await fetch_trace(accessor, scope.trace_id)
        except JaegerApiError as exc:
            if exc.status_code == 404:
                raise enoent(virtual) from exc
            raise
        return _json_bytes(trace)

    raise enoent(virtual)

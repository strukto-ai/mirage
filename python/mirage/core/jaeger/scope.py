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

from dataclasses import dataclass

from mirage.types import PathSpec

OPERATIONS_FILE = "operations.json"
TOP_LEVEL_DIRS = ["services"]


@dataclass
class JaegerScope:
    level: str
    service: str | None = None
    trace_id: str | None = None
    resource_path: str = "/"


def detect_scope(path: PathSpec | str) -> JaegerScope:
    """Classify a resource-relative path into a jaeger tree position.

    The tree is service-scoped because Jaeger's search API requires a service:
    there is no endpoint that lists every trace.

    Args:
        path (PathSpec | str): resource-relative path.

    Returns:
        JaegerScope: the detected position, level "unknown" when unrecognized.
    """
    raw = path.mount_path if isinstance(path, PathSpec) else path
    key = raw.strip("/")

    if not key:
        return JaegerScope(level="root", resource_path=raw)

    parts = key.split("/")

    if parts[0] != "services":
        return JaegerScope(level="unknown", resource_path=raw)

    if len(parts) == 1:
        return JaegerScope(level="services", resource_path=raw)

    service = parts[1]

    if len(parts) == 2:
        return JaegerScope(level="service", service=service, resource_path=raw)

    if len(parts) == 3 and parts[2] == OPERATIONS_FILE:
        return JaegerScope(level="operations",
                           service=service,
                           resource_path=raw)

    if len(parts) == 3 and parts[2] == "traces":
        return JaegerScope(level="traces", service=service, resource_path=raw)

    if (len(parts) == 4 and parts[2] == "traces"
            and parts[3].endswith(".json")):
        return JaegerScope(
            level="trace",
            service=service,
            trace_id=parts[3].removesuffix(".json"),
            resource_path=raw,
        )

    return JaegerScope(level="unknown", resource_path=raw)

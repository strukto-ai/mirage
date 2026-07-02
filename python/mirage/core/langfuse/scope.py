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


@dataclass
class LangfuseScope:
    level: str
    resource_type: str | None = None
    resource_id: str | None = None
    sub_resource: str | None = None
    resource_path: str = "/"


def detect_scope(path: PathSpec) -> LangfuseScope:
    raw = path.mount_path if isinstance(path, PathSpec) else path
    key = raw.strip("/")

    if not key:
        return LangfuseScope(level="root")

    parts = key.split("/")

    if parts[0] in ("traces", "sessions", "prompts", "datasets"):
        rtype = parts[0]
        if len(parts) == 1:
            return LangfuseScope(
                level=rtype,
                resource_type=rtype,
                resource_path=raw,
            )
        if len(parts) == 2:
            if parts[1].endswith(".json") or parts[1].endswith(".jsonl"):
                return LangfuseScope(
                    level="file",
                    resource_type=rtype,
                    resource_id=parts[1].split(".")[0],
                    resource_path=raw,
                )
            return LangfuseScope(
                level=rtype,
                resource_type=rtype,
                resource_id=parts[1],
                resource_path=raw,
            )
        if len(parts) == 3:
            return LangfuseScope(
                level="file",
                resource_type=rtype,
                resource_id=parts[1],
                sub_resource=parts[2],
                resource_path=raw,
            )
        if len(parts) == 4:
            return LangfuseScope(
                level="file",
                resource_type=rtype,
                resource_id=parts[1],
                sub_resource=parts[3],
                resource_path=raw,
            )

    return LangfuseScope(level="root", resource_path=raw)

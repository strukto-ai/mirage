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
class EmailScope:
    use_native: bool
    folder: str | None = None
    resource_path: str = "/"


def detect_scope(path: PathSpec) -> EmailScope:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    key = path.mount_path.strip("/")
    if not key:
        return EmailScope(use_native=False, resource_path="/")
    parts = [x for x in key.split("/") if x]
    if not parts:
        return EmailScope(use_native=False, resource_path="/")
    if key.endswith(".email.json"):
        return EmailScope(
            use_native=False,
            folder=parts[0],
            resource_path=key,
        )
    if len(parts) <= 2:
        return EmailScope(
            use_native=True,
            folder=parts[0],
            resource_path=key,
        )
    return EmailScope(
        use_native=False,
        folder=parts[0],
        resource_path=key,
    )


def extract_folder(paths: list[PathSpec]) -> str | None:
    if not paths:
        return None
    p = paths[0]
    key = p.mount_path.strip("/")
    parts = [x for x in key.split("/") if x]
    return parts[0] if parts else None

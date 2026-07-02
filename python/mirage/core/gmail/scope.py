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
from mirage.utils.key_prefix import mount_prefix_of


@dataclass
class GmailScope:
    use_native: bool
    label_name: str | None = None
    date_str: str | None = None
    resource_path: str = "/"


def detect_scope(path: PathSpec) -> GmailScope:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""

    if path.pattern and path.pattern.endswith(".gmail.json"):
        dir_key = path.directory.strip("/")
        if prefix:
            dir_key = dir_key.removeprefix(prefix.strip("/") + "/")
        parts = dir_key.split("/") if dir_key else []
        if len(parts) == 2:
            return GmailScope(
                use_native=True,
                label_name=parts[0],
                date_str=parts[1],
                resource_path=dir_key,
            )

    key = path.resource_path
    if not key:
        return GmailScope(use_native=True, resource_path="/")

    parts = key.split("/")

    if len(parts) == 1:
        return GmailScope(
            use_native=True,
            label_name=parts[0],
            resource_path=key,
        )

    if len(parts) == 2:
        return GmailScope(
            use_native=True,
            label_name=parts[0],
            date_str=parts[1],
            resource_path=key,
        )

    return GmailScope(
        use_native=False,
        label_name=parts[0],
        date_str=parts[1] if len(parts) >= 2 else None,
        resource_path=key,
    )

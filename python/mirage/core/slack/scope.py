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

import re
from dataclasses import dataclass

from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class SlackScope:
    use_native: bool
    channel_name: str | None = None
    channel_id: str | None = None
    container: str | None = None
    date_str: str | None = None
    target: str | None = None
    resource_path: str = "/"


def _split_dirname(dirname: str) -> tuple[str, str | None]:
    if "__" in dirname:
        name, _, cid = dirname.rpartition("__")
        return name, cid or None
    return dirname, None


def detect_scope(path: PathSpec) -> SlackScope:
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""

    if path.pattern:
        dir_key = path.directory.strip("/")
        if prefix:
            dir_key = dir_key.removeprefix(prefix.strip("/") + "/")
        parts = dir_key.split("/") if dir_key else []
        if len(parts) >= 2 and parts[0] in ("channels", "dms"):
            name, cid = _split_dirname(parts[1])
            target: str | None = None
            date_str: str | None = None
            if len(parts) == 2:
                target = None
            elif len(parts) == 3 and _DATE_RE.match(parts[2]):
                target = "date"
                date_str = parts[2]
            elif (len(parts) == 4 and parts[3] == "files"
                  and _DATE_RE.match(parts[2])):
                target = "files"
                date_str = parts[2]
            return SlackScope(
                use_native=True,
                channel_name=name,
                channel_id=cid,
                container=parts[0],
                date_str=date_str,
                target=target,
                resource_path=dir_key,
            )

    key = path.resource_path
    if not key:
        return SlackScope(use_native=True, resource_path="/")

    parts = key.split("/")
    root = parts[0]

    if root == "users":
        return SlackScope(use_native=False, resource_path=key)

    if root not in ("channels", "dms"):
        return SlackScope(use_native=False, resource_path=key)

    if len(parts) == 1:
        return SlackScope(use_native=True, container=root, resource_path=key)

    if len(parts) == 2:
        name, cid = _split_dirname(parts[1])
        return SlackScope(
            use_native=True,
            channel_name=name,
            channel_id=cid,
            container=root,
            resource_path=key,
        )

    if len(parts) == 3 and _DATE_RE.match(parts[2]):
        name, cid = _split_dirname(parts[1])
        return SlackScope(
            use_native=True,
            channel_name=name,
            channel_id=cid,
            container=root,
            date_str=parts[2],
            target="date",
            resource_path=key,
        )

    if (len(parts) == 4 and parts[3] == "chat.jsonl"
            and _DATE_RE.match(parts[2])):
        name, cid = _split_dirname(parts[1])
        return SlackScope(
            use_native=False,
            channel_name=name,
            channel_id=cid,
            container=root,
            date_str=parts[2],
            target="messages",
            resource_path=key,
        )

    if (len(parts) == 4 and parts[3] == "files" and _DATE_RE.match(parts[2])):
        name, cid = _split_dirname(parts[1])
        return SlackScope(
            use_native=True,
            channel_name=name,
            channel_id=cid,
            container=root,
            date_str=parts[2],
            target="files",
            resource_path=key,
        )

    if (len(parts) == 5 and parts[3] == "files" and _DATE_RE.match(parts[2])):
        name, cid = _split_dirname(parts[1])
        return SlackScope(
            use_native=False,
            channel_name=name,
            channel_id=cid,
            container=root,
            date_str=parts[2],
            target="files",
            resource_path=key,
        )

    return SlackScope(use_native=False, resource_path=key)


def coalesce_scopes(paths: list[PathSpec]) -> SlackScope | None:
    if not paths:
        return None
    scopes = [detect_scope(p) for p in paths]
    first = scopes[0]
    container = first.container
    channel = first.channel_name
    cid = first.channel_id
    target = first.target
    if container is None or channel is None:
        return None
    for s in scopes[1:]:
        if (s.container != container or s.channel_name != channel
                or s.channel_id != cid or s.target != target):
            return None
    resource_path = (f"{container}/{channel}__{cid}"
                     if cid else f"{container}/{channel}")
    return SlackScope(
        use_native=True,
        container=container,
        channel_name=channel,
        channel_id=cid,
        target=target,
        resource_path=resource_path,
    )

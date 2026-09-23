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

from datetime import datetime, timezone

from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.delta import spec_for


def virtual_of(root: PathSpec, relative: str) -> str:
    """Lift a mount-relative path onto the mount ``root`` sits behind.

    Args:
        root (PathSpec): Any path on the target mount, read for its
            prefix.
        relative (str): Mount-relative path, with or without slashes.
    """
    prefix = mount_prefix_of(root.virtual, root.vfs_path).rstrip("/")
    stem = relative.strip("/")
    if not stem:
        return prefix or "/"
    return f"{prefix}/{stem}" if prefix else f"/{stem}"


def event_at(
    root: PathSpec,
    relative: str,
    kind: FileChangeKind,
    previous: str | None = None,
) -> FileEvent:
    """Build one framed ``FileEvent`` for a mount-relative path.

    The timestamp is when the mapping ran, not when the service says
    the change happened: ``FileEvent`` documents its stamp as the
    observation time, and a service clock would be a different clock
    from every other producer's.

    Args:
        root (PathSpec): Any path on the target mount, read for its
            prefix.
        relative (str): Mount-relative path that changed.
        kind (FileChangeKind): What happened to it.
        previous (str | None): Mount-relative prior path, for a MOVE.
    """
    prior = (spec_for(root, virtual_of(root, previous))
             if previous is not None else None)
    return FileEvent(kind=kind,
                     path=spec_for(root, virtual_of(root, relative)),
                     timestamp=datetime.now(timezone.utc),
                     previous_path=prior)


def field(payload: JsonValue, name: str) -> JsonValue:
    """Read one field from a notification body, or None.

    A payload arrives as whatever the service sent, so it may not be an
    object at all; a reader that assumed one would raise on a malformed
    delivery rather than skipping it.

    Args:
        payload (JsonValue): The notification body as delivered.
        name (str): Field to read.
    """
    if not isinstance(payload, dict):
        return None
    return payload.get(name)


def text_field(payload: JsonValue, name: str) -> str | None:
    """Read one string field from a notification body, or None.

    Args:
        payload (JsonValue): The notification body as delivered.
        name (str): Field to read.
    """
    value = field(payload, name)
    return value if isinstance(value, str) else None

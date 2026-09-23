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

from mirage.types import JsonValue, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def parent_path(path: PathSpec) -> PathSpec:
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    stripped = path.mount_path.rstrip("/")
    parent_relative = stripped.rsplit("/", 1)[0] if "/" in stripped else "/"
    if not parent_relative.startswith("/"):
        parent_relative = "/" + parent_relative
    if prefix:
        original = prefix.rstrip("/")
        if parent_relative != "/":
            original += parent_relative
    else:
        original = parent_relative
    return PathSpec.from_str_path(original or "/",
                                  mount_key(original or "/", prefix))


def is_directory_metadata(metadata: JsonValue) -> bool:
    """Whether a Files API metadata object describes a directory.

    The SDK spells it two ways depending on the endpoint: directory
    listings carry ``is_directory``, while a metadata HEAD carries
    ``object_type`` ("DIRECTORY" / "VOLUME_DIRECTORY").

    Args:
        metadata (JsonValue): SDK metadata object for one entry.

    Returns:
        bool: True when the entry is a directory.
    """
    value = getattr(metadata, "is_directory", None)
    if value is not None:
        return bool(value)
    object_type = getattr(metadata, "object_type", None)
    if object_type is None:
        return False
    return str(object_type).lower().endswith("directory")

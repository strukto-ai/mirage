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

from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def ensure_path_spec(path: PathSpec | str) -> PathSpec:
    if isinstance(path, PathSpec):
        return path
    return PathSpec.from_str_path(path)


def parent_path(path: PathSpec | str) -> PathSpec:
    path = ensure_path_spec(path)
    prefix = mount_prefix_of(path.virtual, path.resource_path)
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

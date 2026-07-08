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

import dataclasses

from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry


async def resolve_globs(
    classified: list[str | PathSpec],
    registry: MountRegistry,
    text_args: set[str] | None = None,
) -> list[str | PathSpec]:
    """Resolve glob patterns in PathSpec args, preserving PathSpec type.

    Globs are resolved via resource.resolve_glob. Non-glob PathSpec
    and plain str items pass through unchanged.

    Args:
        classified (list[str | PathSpec]): text arguments (str) and
            paths (PathSpec).
        registry (MountRegistry): mount registry.
        text_args (set[str] | None): args that CommandSpec says are TEXT,
            skip glob expansion for these.
    """
    result: list[str | PathSpec] = []
    for item in classified:
        if isinstance(item, PathSpec) and item.pattern:
            if text_args and item.virtual in text_args:
                result.append(item.virtual)
                continue
            try:
                mount = registry.mount_for(item.virtual)
                prefix = mount.prefix.rstrip("/")
                # Stamp the backend key so readdir addresses the correct
                # resource-relative path.
                item = dataclasses.replace(item,
                                           resource_path=mount_key(
                                               item.virtual, prefix))
                resolved = await mount.resource.resolve_glob([item],
                                                             prefix=prefix)
                # bash with nullglob off: a zero-match glob stays the
                # literal word instead of vanishing.
                if not resolved:
                    result.append(item)
                    continue
                for p in resolved:
                    if isinstance(p, PathSpec):
                        result.append(p)
                    else:
                        full = prefix + p if not p.startswith(prefix) else p
                        result.append(
                            PathSpec.from_str_path(full,
                                                   mount_key(full, prefix)))
            except (ValueError, AttributeError, TypeError):
                result.append(item)
        elif isinstance(item, PathSpec):
            result.append(item)
        else:
            result.append(item)
    return result

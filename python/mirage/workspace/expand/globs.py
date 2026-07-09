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


def _match_display(item: PathSpec, match: PathSpec) -> PathSpec:
    """Stamp a glob match with the display form the user's word implies.

    Bash expands `sub/*.txt` to relative matches (`sub/a.txt`), keeping
    the typed prefix. The glob item's raw_path records the word as
    typed; matches rebuild it by swapping the resolved directory prefix
    for the typed one. Absolute words (no raw_path) keep the resolved
    virtual.

    Args:
        item (PathSpec): the glob word being resolved.
        match (PathSpec): one resolved match.
    """
    if item.raw_path is None or match.raw_path is not None:
        return match
    if not match.virtual.startswith(item.directory):
        return match
    raw_dir = item.raw_path[:item.raw_path.rfind("/") + 1]
    display = raw_dir + match.virtual[len(item.directory):]
    return dataclasses.replace(match, raw_path=display)


async def resolve_globs(
    classified: list[str | PathSpec],
    registry: MountRegistry,
) -> list[str | PathSpec]:
    """Resolve glob patterns in PathSpec args, preserving PathSpec type.

    Globs are resolved via resource.resolve_glob. Non-glob PathSpec
    and plain str items pass through unchanged. Spec-TEXT words never
    arrive here as PathSpec: per-position kinds keep them plain text at
    classification time.

    Args:
        classified (list[str | PathSpec]): text arguments (str) and
            paths (PathSpec).
        registry (MountRegistry): mount registry.
    """
    result: list[str | PathSpec] = []
    for item in classified:
        if isinstance(item, PathSpec) and item.pattern:
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
                        result.append(_match_display(item, p))
                    else:
                        full = prefix + p if not p.startswith(prefix) else p
                        result.append(
                            _match_display(
                                item,
                                PathSpec.from_str_path(full,
                                                       mount_key(full,
                                                                 prefix))))
            except (ValueError, AttributeError, TypeError):
                result.append(item)
        elif isinstance(item, PathSpec):
            result.append(item)
        else:
            result.append(item)
    return result

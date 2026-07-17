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
from mirage.utils.glob_walk import has_glob, spell_match
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry


async def _walk_segments(item: PathSpec, mount: MountEntry,
                         prefix: str) -> list[PathSpec]:
    """Expand a mid-path pattern level by level via resolve_glob.

    A glob in a non-final segment (``s*/x.txt``) cannot resolve in one
    listing: each glob segment is matched against its (already
    expanded) parent directory, using the backend's own single-level
    ``resolve_glob`` per parent, so no backend needs mid-path support.
    Matches are spelled the way bash expansion implies (typed head +
    matched tail). An intermediate match that cannot be listed is
    skipped, matching bash's directories-only descent.

    Args:
        item (PathSpec): the classify-shaped glob word.
        mount (MountEntry): the mount owning the word.
        prefix (str): the mount prefix with no trailing slash.
    """
    segments = item.virtual.strip("/").split("/")
    first = next(i for i, seg in enumerate(segments) if has_glob(seg))
    walked = len(segments) - first
    level = ["/" + "/".join(segments[:first])]
    for seg in segments[first:]:
        gathered: list[str] = []
        for parent in level:
            dir_virtual = parent.rstrip("/") + "/"
            spec = PathSpec(virtual=dir_virtual,
                            directory=dir_virtual,
                            resource_path=mount_key(dir_virtual, prefix),
                            pattern=seg,
                            resolved=False)
            try:
                matches = await mount.resource.resolve_glob([spec],
                                                            prefix=prefix)
            except OSError:
                # This parent is not a listable directory; bash skips it
                # during descent.
                continue
            for m in matches:
                virtual = m.virtual if isinstance(
                    m, PathSpec) else (m if m.startswith(prefix) else prefix +
                                       m)
                gathered.append(virtual)
        level = gathered
        if not level:
            return []
    item_raw = item.raw_path
    return [
        dataclasses.replace(PathSpec.from_str_path(v, mount_key(v, prefix)),
                            raw_path=spell_match(item_raw, v, walked))
        for v in level
    ]


def _match_raw(item: PathSpec, match: PathSpec) -> PathSpec:
    """Stamp a glob match with the spelling the user's word implies.

    Bash expands `sub/*.txt` to relative matches (`sub/a.txt`), keeping
    the typed prefix. The glob item's raw_path records the word as
    typed; matches rebuild it by swapping the resolved directory prefix
    for the typed one. Words with no distinct spelling (absolute:
    raw_path == virtual) keep the resolved virtual, as do matches that
    already carry one.

    Args:
        item (PathSpec): the glob word being resolved.
        match (PathSpec): one resolved match.
    """
    raw = item.raw_path
    if raw == item.virtual or match.raw_path != match.virtual:
        return match
    if not match.virtual.startswith(item.directory):
        return match
    raw_dir = raw[:raw.rfind("/") + 1]
    spelled = raw_dir + match.virtual[len(item.directory):]
    return dataclasses.replace(match, raw_path=spelled)


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
                if has_glob(item.directory):
                    resolved = await _walk_segments(item, mount, prefix)
                else:
                    resolved = await mount.resource.resolve_glob([item],
                                                                 prefix=prefix)
                # bash with nullglob off: a zero-match glob stays the
                # literal word instead of vanishing.
                if not resolved:
                    result.append(item)
                    continue
                for p in resolved:
                    if isinstance(p, PathSpec):
                        result.append(_match_raw(item, p))
                    else:
                        full = prefix + p if not p.startswith(prefix) else p
                        result.append(
                            _match_raw(
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

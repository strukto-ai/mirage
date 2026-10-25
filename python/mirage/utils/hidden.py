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


from collections.abc import Iterable, Mapping, Sequence

from mirage.rs.policy import (
    MODES,
    from_units,
    link_trace_value,
    policy_anchor_depth,
    policy_is_glob,
    policy_paths,
    policy_show_head,
    policy_vars,
    units,
    visibility_matcher,
)
from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.utils.path import trace_symlinks


def is_glob(entry: str) -> bool:
    return policy_is_glob(units(entry))


def anchor_depth(entry: str) -> int:
    return policy_anchor_depth(units(entry))


def classify_paths(entries: Iterable[str]) -> HiddenPaths | None:
    paths, patterns = policy_paths(tuple(units(value) for value in entries))
    return (
        HiddenPaths(
            paths=tuple(from_units(v) for v in paths),
            patterns=tuple(from_units(v) for v in patterns),
        )
        if paths or patterns
        else None
    )


def classify_vars(entries: Iterable[str]) -> HiddenVars | None:
    names, patterns = policy_vars(tuple(units(value) for value in entries))
    return (
        HiddenVars(
            names=tuple(from_units(v) for v in names),
            patterns=tuple(from_units(v) for v in patterns),
        )
        if names or patterns
        else None
    )


def hide_depth(hidden: HiddenPaths | None, virtual: str) -> int | None:
    if hidden is None:
        return None
    return visibility_matcher(Visibility(paths=hidden)).hide_depth(
        units(virtual)
    )


def path_hidden(hidden: HiddenPaths | None, virtual: str) -> bool:
    return hide_depth(hidden, virtual) is not None


def show_head(entry: str) -> str:
    return from_units(policy_show_head(units(entry)))


def show_depth(shown: ShownPaths | None, virtual: str) -> int | None:
    if shown is None:
        return None
    return visibility_matcher(Visibility(shown=shown)).show_depth(
        units(virtual)
    )


def path_visible(vis: Visibility | None, virtual: str) -> bool:
    if vis is None or vis.paths is None:
        return True
    return visibility_matcher(vis).path_visible(units(virtual))


def shown_mode(
    shown: ShownPaths | None, virtual: str
) -> tuple[int, MountMode] | None:
    if shown is None:
        return None
    result = visibility_matcher(Visibility(shown=shown)).shown_mode(
        units(virtual)
    )
    return None if result is None else (result[0], MODES[result[1]])


def path_covers(
    hidden: HiddenPaths | None, virtual: str, ancestors: bool = True
) -> bool:
    if hidden is None:
        return False
    return visibility_matcher(Visibility(paths=hidden)).path_covers(
        units(virtual), ancestors
    )


def move_reveals(vis: Visibility | None, src: str, dst: str) -> bool:
    if vis is None or vis.paths is None:
        return False
    return visibility_matcher(vis).move_reveals(units(src), units(dst))


def classify_shows(entries: Iterable[ShowEntry]) -> ShownPaths | None:
    listed = tuple(entries)
    return ShownPaths(entries=listed) if listed else None


def leads_hidden(
    vis: Visibility | None, virtual: str, links: Mapping[str, str]
) -> bool:
    if vis is None or not links:
        return False
    return visibility_matcher(vis).link_trace_hidden(
        link_trace_value(trace_symlinks(virtual, links)),
    )


def visible_links(
    vis: Visibility | None, paths: Sequence[str], links: Mapping[str, str]
) -> tuple[bool, ...]:
    if vis is None:
        return (True,) * len(paths)
    return tuple(
        visibility_matcher(vis).visible_links(
            tuple(
                (units(path), link_trace_value(trace_symlinks(path, links)))
                for path in paths
            )
        )
    )


def hidden_under(vis: Visibility | None, virtual: str) -> bool:
    if vis is None or vis.paths is None:
        return False
    return visibility_matcher(vis).hides_intersect(units(virtual))


def hides_intersect(hidden: HiddenPaths | None, virtual: str) -> bool:
    if hidden is None:
        return False
    return visibility_matcher(Visibility(paths=hidden)).hides_intersect(
        units(virtual)
    )


def var_hidden(vis: Visibility | None, name: str) -> bool:
    if vis is None or vis.vars is None:
        return False
    return visibility_matcher(vis).var_hidden(units(name))

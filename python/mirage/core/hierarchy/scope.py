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

from collections.abc import Callable
from dataclasses import dataclass, field

from mirage.core.hierarchy.codec import RAW, Codec
from mirage.types import ContentType, PathSpec

ROOT = "root"
INVALID = "invalid"


@dataclass(frozen=True, slots=True)
class Slot:
    """One dynamic segment of a scope.

    Args:
        name (str): key the decoded value is stored under.
        codec (Codec): how the segment encodes the value.
        id_key (str | None): set for ``<label>__<id>`` composite segments:
            the decoded payload splits on its LAST ``__`` (so a three-part
            ``KEY__name__id`` keeps ``KEY__name`` as the label), the label
            stored under ``name`` and the id under ``id_key``. A payload
            with no ``__`` or an empty half does not match the scope.
        variadic (bool): the slot stands for a run of one or more
            consecutive segments instead of exactly one. Segments before
            it anchor at the start of the path, segments after it at the
            end, every segment in the run must decode, and the stored
            value comes from the run's DEEPEST segment: notion's pages
            nest arbitrarily, and ``pages/a__1/b__2/page.json`` stores
            ``page=b, page_id=2`` because the innermost page is the one
            the path addresses. At most one variadic slot per scope.
    """
    name: str
    codec: Codec = RAW
    id_key: str | None = None
    variadic: bool = False


Segment = str | Slot


@dataclass(frozen=True, slots=True)
class Scope:
    """One addressable position in a fixed API hierarchy.

    Args:
        kind (str): the position's name; listers, probes and readers key
            on it.
        segments (tuple[Segment, ...]): the path shape, literals and
            slots.
        leaf (bool): whether the position is a file rather than a
            directory.
        filetype (ContentType | None): rendered type of a leaf; None on
            directories.
        probed (bool): whether stat must prove existence (parent listing
            by default); False for positions that exist by construction,
            like the top-level directories.
    """
    kind: str
    segments: tuple[Segment, ...]
    leaf: bool = False
    filetype: ContentType | None = None
    probed: bool = True


DetectFn = Callable[[PathSpec | str], "ScopeMatch"]


@dataclass(frozen=True, slots=True)
class ScopeMatch:
    """Where in the hierarchy a path landed.

    Args:
        kind (str): the matched scope's kind, or ``root``/``invalid``.
        slots (dict[str, str]): decoded dynamic segments by name.
        vfs_path (str): the raw path that was classified.
        scope (Scope | None): the matched scope; None for root and
            invalid.
        pattern (str | None): the glob the line typed for the directory's
            children, set only for a kind named in ``pattern_kinds`` and
            None everywhere else. A lister whose listing is a window
            moves that window to the span the glob asks for instead of
            filtering its own; every other consumer ignores the field,
            the way a command ignores the ``CommandOpts`` facts it does
            not read.
    """
    kind: str
    vfs_path: str
    slots: dict[str, str] = field(default_factory=dict)
    scope: Scope | None = None
    pattern: str | None = None


def decode_slot(slot: Slot, part: str) -> dict[str, str] | None:
    """Decode one path segment through a slot, None when it does not fit.

    Args:
        slot (Slot): the dynamic segment.
        part (str): raw path segment.
    """
    decoded = slot.codec.decode(part)
    if decoded is None:
        return None
    if slot.id_key is not None:
        label, sep, ident = decoded.rpartition("__")
        if not sep or not label or not ident:
            return None
        return {slot.name: label, slot.id_key: ident}
    return {slot.name: decoded}


def variadic_slot(segments: tuple[Segment, ...]) -> tuple[int, Slot] | None:
    """The scope's variadic slot and its position, None when it has none.

    Args:
        segments (tuple[Segment, ...]): one scope's path shape.
    """
    found: tuple[int, Slot] | None = None
    for i, segment in enumerate(segments):
        if isinstance(segment, Slot) and segment.variadic:
            if found is not None:
                raise ValueError("a scope holds at most one variadic slot")
            found = (i, segment)
    return found


def _match_run(segments: tuple[Segment, ...],
               parts: list[str]) -> dict[str, str] | None:
    slots: dict[str, str] = {}
    for segment, part in zip(segments, parts):
        if isinstance(segment, str):
            if part != segment:
                return None
            continue
        values = decode_slot(segment, part)
        if values is None:
            return None
        slots.update(values)
    return slots


def _match_segments(segments: tuple[Segment, ...],
                    parts: list[str]) -> dict[str, str] | None:
    found = variadic_slot(segments)
    if found is None:
        if len(segments) != len(parts):
            return None
        return _match_run(segments, parts)
    if len(parts) < len(segments):
        return None
    at, slot = found
    tail_len = len(segments) - at - 1
    head = _match_run(segments[:at], parts[:at])
    if head is None:
        return None
    tail = _match_run(segments[at + 1:], parts[len(parts) - tail_len:])
    if tail is None:
        return None
    values: dict[str, str] | None = None
    for part in parts[at:len(parts) - tail_len]:
        values = decode_slot(slot, part)
        if values is None:
            return None
    if values is None:
        return None
    return {**head, **values, **tail}


def match_scope(scopes: tuple[Scope, ...],
                parts: list[str]) -> tuple[Scope, dict[str, str]] | None:
    """Match path segments against the table, first declared scope wins.

    Args:
        scopes (tuple[Scope, ...]): the backend's scope table.
        parts (list[str]): non-empty path segments.
    """
    for scope in scopes:
        slots = _match_segments(scope.segments, parts)
        if slots is not None:
            return scope, slots
    return None


def make_detect_scope(scopes: tuple[Scope, ...]) -> DetectFn:
    """Build a path classifier from a scope table.

    The classifier is the single description of the backend's tree:
    readdir, stat, read, and any search push-down all dispatch on its
    result, so the file surface and the command surface cannot disagree
    about what a path means. Hidden segments classify as invalid, which
    every consumer turns into ENOENT.

    Postgres's table, classified level by level::

        path                             kind         slots
        /                                root         {}
        /public                          schema       {schema}
        /public/tables                   kind         {schema, kind}
        /public/tables/books             entity       {schema, kind, entity}
        /public/tables/books/rows.jsonl  entity_rows  {schema, kind, entity}

    ``kind`` names the level a path landed on; the slots identify the
    branch taken at each dynamic level above it. Literal levels
    (``rows.jsonl``) contribute no slot, and one dynamic level can
    contribute two (``id_key``).

    Args:
        scopes (tuple[Scope, ...]): the backend's scope table, matched in
            declaration order.
    """
    for scope in scopes:
        variadic_slot(scope.segments)

    def detect_scope(path: PathSpec | str) -> ScopeMatch:
        raw = path.mount_path if isinstance(path, PathSpec) else path
        key = raw.strip("/")
        if not key:
            return ScopeMatch(kind=ROOT, vfs_path=raw)
        parts = key.split("/")
        if any(p.startswith(".") for p in parts):
            return ScopeMatch(kind=INVALID, vfs_path=raw)
        matched = match_scope(scopes, parts)
        if matched is None:
            return ScopeMatch(kind=INVALID, vfs_path=raw)
        scope, slots = matched
        return ScopeMatch(kind=scope.kind,
                          vfs_path=raw,
                          slots=slots,
                          scope=scope)

    return detect_scope

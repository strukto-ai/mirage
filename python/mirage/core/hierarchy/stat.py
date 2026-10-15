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

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.readdir import ExtraFn, Guard
from mirage.core.hierarchy.scope import ROOT, DetectFn, ScopeMatch
from mirage.errors.fs import enoent
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path

StatHook = Callable[
    [A, ScopeMatch, PathSpec, FileStat | None, FileStat | None],
    Awaitable[FileStat],
]
RowFn = Callable[..., FileStat]


def entry_stat(
    id_field: str, filetype: ContentType | FileType | None = None
) -> RowFn:
    """The row most id-addressed nodes share, keyed by an id field.

    The listed name, size and modified time, and the node's id under
    ``id_field`` in ``extra``, with whatever else the lister keeps for
    a child listing to read back. A kind whose shape differs builds its
    own row instead.

    ``filetype`` is the node's kind: a ``FileType`` for a non-regular
    node (a directory entry, e.g. a linear team or trello board), a
    ``ContentType`` for a regular file, whose node kind is then FILE, or
    None for a regular file typed by its name (a mail attachment).

    Args:
        id_field (str): the ``extra`` key the node's id rides under.
        filetype (ContentType | FileType | None): the node's kind.
    """

    def build(
        name: str,
        ident: str,
        size: int | None = None,
        modified: str | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> FileStat:
        kept = {**(extra or {}), id_field: ident}
        if isinstance(filetype, FileType):
            return FileStat(
                name=name,
                type=filetype,
                size=size,
                modified=modified or None,
                extra=kept,
            )
        return FileStat(
            name=name,
            type=FileType.FILE,
            content=(
                content_type_for_path(name) if filetype is None else filetype
            ),
            size=size,
            modified=modified or None,
            extra=kept,
        )

    return build


def make_stat(
    detect: DetectFn,
    *,
    guards: Mapping[str, Guard[A]] | None = None,
    extras: Mapping[str, ExtraFn] | None = None,
    overrides: Mapping[str, StatHook[A]] | None = None,
) -> Callable[..., Awaitable[FileStat]]:
    """Build a hierarchy stat: the listed row, or a shape the kind holds.

    A path its parent's listing names answers with that row, which the
    mount hands in (``entry``). A kind whose existence the API answers
    directly has a guard instead, and one that exists by construction
    (the top-level directories) needs no proof; both answer the shape
    their scope gives them. An override replaces the whole answer for a
    kind with a bespoke stat, handed what is at the path and at its
    parent.

    Args:
        detect (DetectFn): the backend's scope classifier.
        guards (Mapping[str, Guard]): per-kind existence checks for a
            path no listing names.
        extras (Mapping[str, ExtraFn]): per-kind ``FileStat.extra``
            payloads derived from the slots.
        overrides (Mapping[str, StatHook]): per-kind full replacements.
    """

    async def stat(
        accessor: A,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat:
        virtual = path.virtual
        match = detect(path)
        if match.kind == ROOT:
            return FileStat(name="/", type=FileType.DIRECTORY)
        scope = match.scope
        if scope is None:
            raise enoent(virtual)
        override = overrides.get(match.kind) if overrides is not None else None
        if override is not None:
            return await override(accessor, match, path, entry, parent)
        if entry is not None:
            return entry
        guard = guards.get(match.kind) if guards is not None else None
        if guard is not None:
            await guard(accessor, match, virtual)
        elif scope.probed:
            raise enoent(virtual)
        name = path.vfs_path.strip("/").split("/")[-1]
        extra_fn = extras.get(match.kind) if extras is not None else None
        extra = extra_fn(match) if extra_fn is not None else {}
        if not scope.leaf:
            return FileStat(name=name, type=FileType.DIRECTORY, extra=extra)
        return FileStat(
            name=name,
            type=FileType.FILE,
            content=scope.filetype
            if scope.filetype is not None
            else ContentType.JSON,
            extra=extra,
        )

    return stat

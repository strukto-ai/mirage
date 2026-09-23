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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.codec import JSON_NAME, PATH_SAFE, RAW, Codec
from mirage.core.hierarchy.scope import (DetectFn, Scope, ScopeMatch, Segment,
                                         Slot, make_detect_scope)
from mirage.types import ContentType
from mirage.utils.filetype import content_type_for_extension
from mirage.vfs.qdrant.config import QdrantConfig

TXT = Codec(suffix=".txt")


def scopes_for(config: QdrantConfig) -> tuple[Scope, ...]:
    """The mount's scope table, shaped by its config.

    The tree is a function of the mount config, not of the backend: a
    pinned ``collection`` removes the leading collection segment, every
    ``group_by`` column adds one directory level, and ``text_field`` /
    ``blob_field`` each add a leaf suffix beside the ``.json`` row.
    Group slots are named positionally (``g0``, ``g1``, ...) so a column
    named ``table`` cannot collide with the collection slot;
    ``filters_of`` maps them back to column names. A group slot decodes
    through ``PATH_SAFE``, so its filter holds the exact value the
    directory was rendered from; a ``basename_fields`` slot stays
    ``RAW`` because its rendering drops the value's parents and the
    lister resolves it against the payload instead. Every partial depth
    shares the one ``group`` kind, and its lister derives the depth from
    the slots, so the lister table stays static while the scope table
    varies per mount.

    Args:
        config (QdrantConfig): the mount's config.
    """
    prefix: tuple[Segment,
                  ...] = () if config.collection else (Slot("table"), )
    groups = tuple(
        Slot(f"g{i}", RAW if column in config.basename_fields else PATH_SAFE)
        for i, column in enumerate(config.group_by))
    scopes = [
        Scope(kind="group", segments=prefix + groups[:depth])
        for depth in range(len(groups) + 1) if depth or prefix
    ]
    full = prefix + groups
    scopes.append(
        Scope(kind="row_json",
              segments=full + (Slot("row_id", JSON_NAME), ),
              leaf=True,
              filetype=ContentType.TEXT))
    if config.text_field:
        scopes.append(
            Scope(kind="row_text",
                  segments=full + (Slot("row_id", TXT), ),
                  leaf=True,
                  filetype=ContentType.TEXT))
    if config.blob_field:
        blob = Codec(suffix="." + config.blob_ext)
        scopes.append(
            Scope(kind="row_blob",
                  segments=full + (Slot("row_id", blob), ),
                  leaf=True,
                  filetype=content_type_for_extension(config.blob_ext)))
    return tuple(scopes)


def _detect(accessor: QdrantAccessor) -> DetectFn:
    return make_detect_scope(scopes_for(accessor.config))


detect_for = per_accessor(_detect)


def table_of(config: QdrantConfig, match: ScopeMatch) -> str:
    """The collection a match addresses: pinned, or the path's first slot.

    Args:
        config (QdrantConfig): the mount's config.
        match (ScopeMatch): a match from this mount's classifier.
    """
    if config.collection:
        return config.collection
    return match.slots["table"]


def filters_of(config: QdrantConfig, match: ScopeMatch) -> dict[str, str]:
    """The match's group filters, keyed back to column names.

    Args:
        config (QdrantConfig): the mount's config.
        match (ScopeMatch): a match from this mount's classifier.
    """
    filters: dict[str, str] = {}
    for i, column in enumerate(config.group_by):
        value = match.slots.get(f"g{i}")
        if value is None:
            break
        filters[column] = value
    return filters

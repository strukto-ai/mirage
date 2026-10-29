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
from mirage.core.hierarchy.scope import DetectFn, Scope, make_detect_scope
from mirage.core.vector.scope import blob_leaf, row_scopes
from mirage.core.vector.types import Leaf
from mirage.types import ContentType
from mirage.vfs.qdrant.config import QdrantConfig

TXT = Codec(suffix=".txt")


def scopes_for(config: QdrantConfig) -> tuple[Scope, ...]:
    """The mount's scope table, shaped by its config.

    A pinned ``collection`` removes the leading collection segment, and
    ``text_field`` / ``blob_field`` each add a leaf suffix beside the
    ``.json`` row. A group slot decodes through ``PATH_SAFE``, so its
    filter holds the exact value the directory was rendered from; a
    ``basename_fields`` slot stays ``RAW`` because its rendering drops
    the value's parents and the lister resolves it against the payload
    instead.

    Args:
        config (QdrantConfig): the mount's config.
    """
    leaves: list[Leaf] = [("row_json", JSON_NAME, ContentType.TEXT)]
    if config.text_field:
        leaves.append(("row_text", TXT, ContentType.TEXT))
    if config.blob_field:
        leaves.append(blob_leaf(config.blob_ext))
    groups = [
        RAW if column in config.basename_fields else PATH_SAFE
        for column in config.group_by
    ]
    return row_scopes(bool(config.collection), groups, leaves)


def _build_detect(accessor: QdrantAccessor) -> DetectFn:
    return make_detect_scope(scopes_for(accessor.config))


detect_for = per_accessor(_build_detect)

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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.codec import PATH_SAFE, Codec
from mirage.core.hierarchy.scope import DetectFn, Scope, make_detect_scope
from mirage.core.vector.scope import blob_leaf, row_scopes
from mirage.core.vector.types import Leaf
from mirage.types import ContentType
from mirage.vfs.lancedb.config import LanceDBConfig

CARD = Codec(suffix=".md")


def scopes_for(config: LanceDBConfig) -> tuple[Scope, ...]:
    """The mount's scope table, shaped by its config.

    A pinned ``table`` removes the leading table segment, and
    ``blob_column`` adds a second leaf suffix beside the ``.md`` card. A
    group slot decodes through ``PATH_SAFE``, so a value holding ``/``
    keeps its own directory and the WHERE clause holds the exact value.

    Args:
        config (LanceDBConfig): the mount's config.
    """
    leaves: list[Leaf] = [("row_card", CARD, ContentType.TEXT)]
    if config.blob_column:
        leaves.append(blob_leaf(config.blob_ext))
    return row_scopes(
        bool(config.table), [PATH_SAFE] * len(config.group_by), leaves
    )


def _build_detect(accessor: LanceDBAccessor) -> DetectFn:
    return make_detect_scope(scopes_for(accessor.config))


detect_for = per_accessor(_build_detect)

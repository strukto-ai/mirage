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

from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.scope import Scope, Slot, make_detect_scope
from mirage.types import ContentType

ENTITY_FILES = ("schema.json", "semantic.json", "rows.jsonl")

KIND_DIRS = ("tables", "views")


def is_kind(text: str) -> bool:
    """Whether the segment names an entity-kind directory.

    Args:
        text (str): decoded segment payload.
    """
    return text in KIND_DIRS


KIND = Codec(validate=is_kind)

# One description of the tree: readdir, stat, read and grep's line
# search all classify through it, so they cannot disagree about what a
# path means.
SCOPES = (
    Scope(
        kind="database_json",
        segments=("database.json",),
        leaf=True,
        filetype=ContentType.JSON,
        probed=False,
    ),
    Scope(kind="schema", segments=(Slot("schema"),)),
    Scope(kind="kind", segments=(Slot("schema"), Slot("kind", KIND))),
    Scope(
        kind="entity",
        segments=(Slot("schema"), Slot("kind", KIND), Slot("entity")),
    ),
    Scope(
        kind="entity_schema",
        segments=(
            Slot("schema"),
            Slot("kind", KIND),
            Slot("entity"),
            "schema.json",
        ),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(
        kind="entity_semantic",
        segments=(
            Slot("schema"),
            Slot("kind", KIND),
            Slot("entity"),
            "semantic.json",
        ),
        leaf=True,
        filetype=ContentType.JSON,
    ),
    Scope(
        kind="entity_rows",
        segments=(
            Slot("schema"),
            Slot("kind", KIND),
            Slot("entity"),
            "rows.jsonl",
        ),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
)

detect_scope = make_detect_scope(SCOPES)

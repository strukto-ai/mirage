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
from mirage.core.hierarchy.scope import (
    Scope,
    ScopeMatch,
    Slot,
    make_detect_scope,
)
from mirage.core.mongodb.types import KIND_DIR_NAMES, EntityKind
from mirage.types import ContentType


def is_kind_dir(text: str) -> bool:
    """Whether the segment names an entity-kind directory.

    Args:
        text (str): decoded segment payload.
    """
    return text in KIND_DIR_NAMES


KIND = Codec(validate=is_kind_dir)

# One description of the tree: readdir, stat and read all classify
# through it, so they cannot disagree about what a path means.
SCOPES = (
    Scope(kind="database", segments=(Slot("database"),)),
    Scope(
        kind="database_json",
        segments=(Slot("database"), "database.json"),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
    Scope(kind="kind_dir", segments=(Slot("database"), Slot("kind", KIND))),
    Scope(
        kind="entity",
        segments=(Slot("database"), Slot("kind", KIND), Slot("name")),
    ),
    Scope(
        kind="schema_json",
        segments=(
            Slot("database"),
            Slot("kind", KIND),
            Slot("name"),
            "schema.json",
        ),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
    Scope(
        kind="documents",
        segments=(
            Slot("database"),
            Slot("kind", KIND),
            Slot("name"),
            "documents.jsonl",
        ),
        leaf=True,
        filetype=ContentType.TEXT,
    ),
)

detect_scope = make_detect_scope(SCOPES)


def entity_kind(match: ScopeMatch) -> EntityKind:
    """The EntityKind a matched scope's kind directory names.

    Args:
        match (ScopeMatch): a match whose slots hold ``kind``.
    """
    return KIND_DIR_NAMES[match.slots["kind"]]

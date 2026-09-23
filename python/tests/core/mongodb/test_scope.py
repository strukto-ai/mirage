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

from mirage.core.mongodb.scope import detect_scope, entity_kind
from mirage.core.mongodb.types import EntityKind
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _ps(path: str) -> PathSpec:
    return PathSpec.from_str_path(path)


def test_root():
    scope = detect_scope(_ps("/"))
    assert scope.kind == "root"


def test_database():
    scope = detect_scope(_ps("/sample_mflix"))
    assert scope.kind == "database"
    assert scope.slots == {"database": "sample_mflix"}


def test_database_json():
    scope = detect_scope(_ps("/sample_mflix/database.json"))
    assert scope.kind == "database_json"
    assert scope.slots == {"database": "sample_mflix"}


def test_collections_kind_dir():
    scope = detect_scope(_ps("/sample_mflix/collections"))
    assert scope.kind == "kind_dir"
    assert scope.slots == {"database": "sample_mflix", "kind": "collections"}
    assert entity_kind(scope) == EntityKind.COLLECTION


def test_views_kind_dir():
    scope = detect_scope(_ps("/sample_mflix/views"))
    assert scope.kind == "kind_dir"
    assert entity_kind(scope) == EntityKind.VIEW


def test_collection_entity_dir():
    scope = detect_scope(_ps("/sample_mflix/collections/movies"))
    assert scope.kind == "entity"
    assert scope.slots["database"] == "sample_mflix"
    assert entity_kind(scope) == EntityKind.COLLECTION
    assert scope.slots["name"] == "movies"


def test_view_entity_dir():
    scope = detect_scope(_ps("/sample_mflix/views/top_rated"))
    assert scope.kind == "entity"
    assert entity_kind(scope) == EntityKind.VIEW
    assert scope.slots["name"] == "top_rated"


def test_collection_schema_json():
    scope = detect_scope(_ps("/sample_mflix/collections/movies/schema.json"))
    assert scope.kind == "schema_json"
    assert scope.slots["database"] == "sample_mflix"
    assert entity_kind(scope) == EntityKind.COLLECTION
    assert scope.slots["name"] == "movies"


def test_collection_documents_jsonl():
    scope = detect_scope(
        _ps("/sample_mflix/collections/movies/documents.jsonl"))
    assert scope.kind == "documents"
    assert scope.slots["database"] == "sample_mflix"
    assert entity_kind(scope) == EntityKind.COLLECTION
    assert scope.slots["name"] == "movies"


def test_view_documents_jsonl():
    scope = detect_scope(_ps("/sample_mflix/views/top_rated/documents.jsonl"))
    assert scope.kind == "documents"
    assert entity_kind(scope) == EntityKind.VIEW
    assert scope.slots["name"] == "top_rated"


def test_unknown_leaf_under_entity():
    scope = detect_scope(_ps("/sample_mflix/collections/movies/weird.txt"))
    assert scope.kind == "invalid"


def test_unknown_top_segment_under_db():
    scope = detect_scope(_ps("/sample_mflix/randomdir"))
    assert scope.kind == "invalid"


def test_pathspec_with_prefix_root():
    p = PathSpec(
        vfs_path=mount_key("/mongo/", "/mongo"),
        virtual="/mongo/",
        directory="/mongo/",
    )
    scope = detect_scope(p)
    assert scope.kind == "root"


def test_pathspec_with_prefix_database():
    p = PathSpec(
        vfs_path=mount_key("/mongo/sample_mflix", "/mongo"),
        virtual="/mongo/sample_mflix",
        directory="/mongo/",
    )
    scope = detect_scope(p)
    assert scope.kind == "database"
    assert scope.slots == {"database": "sample_mflix"}


def test_pathspec_with_prefix_documents():
    p = PathSpec(
        vfs_path=mount_key(
            "/mongo/sample_mflix/collections/movies/documents.jsonl",
            "/mongo"),
        virtual="/mongo/sample_mflix/collections/movies/documents.jsonl",
        directory="/mongo/sample_mflix/collections/movies/",
    )
    scope = detect_scope(p)
    assert scope.kind == "documents"
    assert scope.slots["database"] == "sample_mflix"
    assert entity_kind(scope) == EntityKind.COLLECTION
    assert scope.slots["name"] == "movies"

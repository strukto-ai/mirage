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

from mirage.core.mongodb.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def test_root():
    scope = detect_scope("/")
    assert scope.level == "root"
    assert scope.database == ""
    assert scope.kind is None
    assert scope.name == ""


def test_database():
    scope = detect_scope("/sample_mflix")
    assert scope.level == "database"
    assert scope.database == "sample_mflix"
    assert scope.kind is None
    assert scope.name == ""


def test_database_json():
    scope = detect_scope("/sample_mflix/database.json")
    assert scope.level == "database_json"
    assert scope.database == "sample_mflix"


def test_collections_kind_dir():
    scope = detect_scope("/sample_mflix/collections")
    assert scope.level == "kind_dir"
    assert scope.database == "sample_mflix"
    assert scope.kind == "collection"


def test_views_kind_dir():
    scope = detect_scope("/sample_mflix/views")
    assert scope.level == "kind_dir"
    assert scope.database == "sample_mflix"
    assert scope.kind == "view"


def test_collection_entity_dir():
    scope = detect_scope("/sample_mflix/collections/movies")
    assert scope.level == "entity"
    assert scope.database == "sample_mflix"
    assert scope.kind == "collection"
    assert scope.name == "movies"


def test_view_entity_dir():
    scope = detect_scope("/sample_mflix/views/top_rated")
    assert scope.level == "entity"
    assert scope.database == "sample_mflix"
    assert scope.kind == "view"
    assert scope.name == "top_rated"


def test_collection_schema_json():
    scope = detect_scope("/sample_mflix/collections/movies/schema.json")
    assert scope.level == "schema_json"
    assert scope.database == "sample_mflix"
    assert scope.kind == "collection"
    assert scope.name == "movies"


def test_collection_documents_jsonl():
    scope = detect_scope("/sample_mflix/collections/movies/documents.jsonl")
    assert scope.level == "documents"
    assert scope.database == "sample_mflix"
    assert scope.kind == "collection"
    assert scope.name == "movies"


def test_view_documents_jsonl():
    scope = detect_scope("/sample_mflix/views/top_rated/documents.jsonl")
    assert scope.level == "documents"
    assert scope.kind == "view"
    assert scope.name == "top_rated"


def test_unknown_leaf_under_entity():
    scope = detect_scope("/sample_mflix/collections/movies/weird.txt")
    assert scope.level == "unknown"


def test_unknown_top_segment_under_db():
    scope = detect_scope("/sample_mflix/randomdir")
    assert scope.level == "unknown"


def test_pathspec_with_prefix_root():
    p = PathSpec(
        resource_path=mount_key("/mongo/", "/mongo"),
        virtual="/mongo/",
        directory="/mongo/",
    )
    scope = detect_scope(p)
    assert scope.level == "root"


def test_pathspec_with_prefix_database():
    p = PathSpec(
        resource_path=mount_key("/mongo/sample_mflix", "/mongo"),
        virtual="/mongo/sample_mflix",
        directory="/mongo/",
    )
    scope = detect_scope(p)
    assert scope.level == "database"
    assert scope.database == "sample_mflix"


def test_pathspec_with_prefix_documents():
    p = PathSpec(
        resource_path=mount_key(
            "/mongo/sample_mflix/collections/movies/documents.jsonl",
            "/mongo"),
        virtual="/mongo/sample_mflix/collections/movies/documents.jsonl",
        directory="/mongo/sample_mflix/collections/movies/",
    )
    scope = detect_scope(p)
    assert scope.level == "documents"
    assert scope.database == "sample_mflix"
    assert scope.kind == "collection"
    assert scope.name == "movies"

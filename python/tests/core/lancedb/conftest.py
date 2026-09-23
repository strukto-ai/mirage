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

import hashlib

import lancedb
import numpy as np
import pyarrow as pa
import pytest
from lancedb.embeddings import EmbeddingFunction, get_registry
from lancedb.pydantic import LanceModel, Vector

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.vfs.lancedb.config import LanceDBConfig

_DIMS = 8
_STUB_NAME = "stub-lancedb-test"


def _vec(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode()).digest()
    arr = np.frombuffer(digest[:_DIMS * 4], dtype=np.uint32).astype(np.float32)
    norm = float(np.linalg.norm(arr)) or 1.0
    return (arr / norm).tolist()


class StubEmbedding(EmbeddingFunction):

    def ndims(self) -> int:
        return _DIMS

    def compute_query_embeddings(self, query, *args, **kwargs):
        if isinstance(query, str):
            return [_vec(query)]
        return [_vec(str(item)) for item in query]

    def compute_source_embeddings(self, texts, *args, **kwargs):
        items = texts.to_pylist() if isinstance(texts,
                                                pa.Array) else list(texts)
        return [_vec(str(item)) for item in items]


def _ensure_registered() -> None:
    registry = get_registry()
    try:
        registry.get(_STUB_NAME)
    except KeyError:
        registry.register(_STUB_NAME)(StubEmbedding)


_ROWS = [
    {
        "id": 1,
        "label": "cat",
        "kind": "big",
        "name": "a big orange cat"
    },
    {
        "id": 2,
        "label": "cat",
        "kind": "small",
        "name": "a small grey cat"
    },
    {
        "id": 3,
        "label": "dog",
        "kind": "big",
        "name": "a big brown dog"
    },
    {
        "id": 4,
        "label": "dog",
        "kind": "small",
        "name": "a small white dog"
    },
]


@pytest.fixture
def lance_config(tmp_path) -> LanceDBConfig:
    _ensure_registered()
    func = get_registry().get(_STUB_NAME).create()

    class Animal(LanceModel):
        id: int
        label: str
        kind: str
        name: str = func.SourceField()
        image_bytes: bytes
        vector: Vector(func.ndims()) = func.VectorField()

    uri = str(tmp_path / "db")
    db = lancedb.connect(uri)
    table = db.create_table("animals", schema=Animal)
    table.add([{
        **row, "image_bytes": f"PNG-{row['id']}".encode()
    } for row in _ROWS])
    return LanceDBConfig(
        uri=uri,
        group_by=["label", "kind"],
        id_column="id",
        title_column="name",
        blob_column="image_bytes",
        blob_ext="png",
        text_column="name",
        vector_column="vector",
    )


@pytest.fixture
def accessor(lance_config) -> LanceDBAccessor:
    return LanceDBAccessor(lance_config)


_EDGED_ROWS = [
    {
        "id": 1,
        "label": "a/b",
        "name": "one"
    },
    {
        "id": 2,
        "label": "",
        "name": "two"
    },
    {
        "id": 3,
        "label": ".env",
        "name": "three"
    },
]


@pytest.fixture
def edged(tmp_path) -> LanceDBAccessor:
    """Group values whose rendering differs from their text, in a table
    that can answer a search.

    Args:
        tmp_path (Path): pytest tmp dir.
    """
    _ensure_registered()
    func = get_registry().get(_STUB_NAME).create()

    class Doc(LanceModel):
        id: int
        label: str
        name: str = func.SourceField()
        vector: Vector(func.ndims()) = func.VectorField()

    uri = str(tmp_path / "edged")
    db = lancedb.connect(uri)
    table = db.create_table("docs", schema=Doc)
    table.add(_EDGED_ROWS)
    return LanceDBAccessor(
        LanceDBConfig(uri=uri,
                      group_by=["label"],
                      id_column="id",
                      title_column="name",
                      text_column="name",
                      vector_column="vector"))

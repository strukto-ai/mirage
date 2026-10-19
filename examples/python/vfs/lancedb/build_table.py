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

import lancedb
import pyarrow as pa
from lancedb.embeddings import EmbeddingFunction, get_registry
from lancedb.pydantic import LanceModel, Vector

FASHION_VOCAB = [
    "men",
    "women",
    "tshirt",
    "shirt",
    "jeans",
    "shoes",
    "sneakers",
    "heels",
    "jacket",
    "dress",
    "blue",
    "red",
    "black",
    "white",
    "green",
    "running",
    "casual",
    "formal",
    "sports",
    "summer",
    "winter",
]
_INDEX = {token: i for i, token in enumerate(FASHION_VOCAB)}

_PRODUCTS = [
    ("Men", "Tshirts", "Blue", "Roadster Men Blue Casual Tshirt"),
    ("Men", "Tshirts", "Black", "HRX Men Black Sports Tshirt"),
    ("Men", "Shoes", "White", "Nike Men White Running Sneakers"),
    ("Men", "Shoes", "Black", "Puma Men Black Formal Shoes"),
    ("Men", "Jeans", "Blue", "Levis Men Blue Casual Jeans"),
    ("Women", "Tshirts", "Red", "Roadster Women Red Casual Tshirt"),
    ("Women", "Shoes", "Red", "Steve Madden Women Red Heels"),
    ("Women", "Shoes", "White", "Adidas Women White Running Sneakers"),
    ("Women", "Dress", "Black", "Zara Women Black Formal Dress"),
    ("Women", "Jeans", "Blue", "H&M Women Blue Summer Jeans"),
]


def _tokens(text: str) -> list[str]:
    return [word.strip(".,").lower() for word in text.split()]


def _embed(text: str) -> list[float]:
    vector = [0.0] * len(FASHION_VOCAB)
    for token in _tokens(text):
        idx = _INDEX.get(token)
        if idx is not None:
            vector[idx] = 1.0
    norm = sum(value * value for value in vector) ** 0.5 or 1.0
    return [value / norm for value in vector]


@get_registry().register("fashion-keyword")
class KeywordEmbedding(EmbeddingFunction):
    def ndims(self) -> int:
        return len(FASHION_VOCAB)

    def compute_query_embeddings(self, query, *args, **kwargs):
        if isinstance(query, str):
            return [_embed(query)]
        return [_embed(str(item)) for item in query]

    def compute_source_embeddings(self, texts, *args, **kwargs):
        items = (
            texts.to_pylist() if isinstance(texts, pa.Array) else list(texts)
        )
        return [_embed(str(item)) for item in items]


def build_table(uri: str, table_name: str = "fashion") -> None:
    func = get_registry().get("fashion-keyword").create()

    class Product(LanceModel):
        id: int
        gender: str
        articleType: str
        baseColour: str
        productDisplayName: str = func.SourceField()
        image_bytes: bytes
        vector: Vector(func.ndims()) = func.VectorField()

    db = lancedb.connect(uri)
    if table_name in db.table_names():
        db.drop_table(table_name)
    table = db.create_table(table_name, schema=Product)
    rows = []
    for idx, (gender, article, colour, name) in enumerate(_PRODUCTS, start=1):
        rows.append(
            {
                "id": idx,
                "gender": gender,
                "articleType": article,
                "baseColour": colour,
                "productDisplayName": name,
                "image_bytes": b"\xff\xd8\xff" + name.encode(),
            }
        )
    table.add(rows)

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

import base64

from fastembed import TextEmbedding
from qdrant_client import QdrantClient, models

MODEL = "sentence-transformers/all-MiniLM-L6-v2"

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


def build_collection(client: QdrantClient,
                     collection: str = "fashion") -> None:
    embedder = TextEmbedding(MODEL)
    names = [name for _, _, _, name in _PRODUCTS]
    vectors = [list(map(float, vector)) for vector in embedder.embed(names)]
    if client.collection_exists(collection):
        client.delete_collection(collection)
    client.create_collection(
        collection,
        vectors_config=models.VectorParams(size=len(vectors[0]),
                                           distance=models.Distance.COSINE),
    )
    points = []
    for idx, ((gender, article, colour, name),
              vector) in enumerate(zip(_PRODUCTS, vectors), start=1):
        image = b"\xff\xd8\xff" + name.encode()
        points.append(
            models.PointStruct(
                id=idx,
                vector=vector,
                payload={
                    "gender": gender,
                    "articleType": article,
                    "baseColour": colour,
                    "productDisplayName": name,
                    "image_b64": base64.b64encode(image).decode(),
                },
            ))
    client.upsert(collection, points=points)
    for field in ("gender", "articleType", "baseColour"):
        client.create_payload_index(
            collection,
            field_name=field,
            field_schema=models.PayloadSchemaType.KEYWORD,
        )

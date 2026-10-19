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
import json
from pathlib import Path

from fastembed import TextEmbedding
from qdrant_client import QdrantClient, models

# fastembed runs the ONNX export of this sentence-transformers model, and
# it is what qdrant-client embeds `search` queries with, so the example
# brings no model dependency of its own.
MODEL = "sentence-transformers/all-MiniLM-L6-v2"

# The rows both language examples seed, so the two mounts read alike.
DATA = json.loads(
    (Path(__file__).resolve().parents[3] / "data" / "qdrant.json").read_text()
)
_PRODUCTS: list[dict[str, str]] = DATA["products"]
# LangChain-style chunks whose lineage lives in a nested ``metadata``
# payload: source document, page, text.
_CHUNKS: list[dict[str, str]] = DATA["chunks"]


def build_collection(
    client: QdrantClient, collection: str = "fashion"
) -> None:
    """(Re)create a product collection with flat, low-cardinality payloads.

    Args:
        client (QdrantClient): the client to build with.
        collection (str): the collection to create, replacing any old one.
    """
    embedder = TextEmbedding(MODEL)
    names = [product["name"] for product in _PRODUCTS]
    vectors = [list(map(float, vector)) for vector in embedder.embed(names)]
    if client.collection_exists(collection):
        client.delete_collection(collection)
    client.create_collection(
        collection,
        vectors_config=models.VectorParams(
            size=len(vectors[0]), distance=models.Distance.COSINE
        ),
    )
    points = []
    for idx, (product, vector) in enumerate(zip(_PRODUCTS, vectors), start=1):
        image = b"\xff\xd8\xff" + product["name"].encode()
        points.append(
            models.PointStruct(
                id=idx,
                vector=vector,
                payload={
                    "gender": product["gender"],
                    "articleType": product["articleType"],
                    "baseColour": product["baseColour"],
                    "productDisplayName": product["name"],
                    "image_b64": base64.b64encode(image).decode(),
                },
            )
        )
    client.upsert(collection, points=points)
    for field in ("gender", "articleType", "baseColour"):
        client.create_payload_index(
            collection,
            field_name=field,
            field_schema=models.PayloadSchemaType.KEYWORD,
        )


def build_lineage_collection(
    client: QdrantClient, collection: str = "company_docs"
) -> None:
    """(Re)create a chunk collection whose payload nests the source document.

    Args:
        client (QdrantClient): the client to build with.
        collection (str): the collection to create, replacing any old one.
    """
    embedder = TextEmbedding(MODEL)
    texts = [chunk["text"] for chunk in _CHUNKS]
    vectors = [list(map(float, vector)) for vector in embedder.embed(texts)]
    if client.collection_exists(collection):
        client.delete_collection(collection)
    client.create_collection(
        collection,
        vectors_config=models.VectorParams(
            size=len(vectors[0]), distance=models.Distance.COSINE
        ),
    )
    client.upsert(
        collection,
        points=[
            models.PointStruct(
                id=100 + idx,
                vector=vector,
                payload={
                    "page_content": chunk["text"],
                    "metadata": {
                        "source": chunk["source"],
                        "page": chunk["page"],
                    },
                },
            )
            for idx, (chunk, vector) in enumerate(
                zip(_CHUNKS, vectors), start=1
            )
        ],
    )
    # Qdrant spells a nested payload path with a dot, in filters and in
    # index names alike; the mount config spells it the same way.
    client.create_payload_index(
        collection,
        field_name="metadata.source",
        field_schema=models.PayloadSchemaType.KEYWORD,
    )

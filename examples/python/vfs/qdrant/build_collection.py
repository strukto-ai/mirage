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
import math
import re
from pathlib import Path

from qdrant_client import QdrantClient, models

# The rows both language examples seed, so the two mounts read alike.
DATA = json.loads(
    (Path(__file__).resolve().parents[3] / "data" / "qdrant.json").read_text()
)
_PRODUCTS: list[dict[str, str]] = DATA["products"]
# LangChain-style chunks whose lineage lives in a nested ``metadata``
# payload: source document, page, text.
_CHUNKS: list[dict[str, str]] = DATA["chunks"]


# A bag of words over the corpus vocabulary stands in for a sentence
# model: a word's first five letters are its stem, so `refund` meets
# `refunds`, a query word the corpus never used is dropped, and the vector
# is unit length so cosine similarity is word overlap. A real model
# (fastembed's all-MiniLM-L6-v2, say) plugs into the same `embed` hook the
# mount config takes.
def _stems(text: str) -> list[str]:
    return [word[:5] for word in re.findall(r"[^\W_]+", text.lower())]


def _vocabulary() -> dict[str, int]:
    vocab: dict[str, int] = {}
    texts = [p["name"] for p in _PRODUCTS] + [c["text"] for c in _CHUNKS]
    for text in texts:
        for stem in _stems(text):
            vocab.setdefault(stem, len(vocab))
    return vocab


_VOCAB = _vocabulary()


def embed(text: str) -> list[float]:
    """The unit-length bag-of-words vector of a text.

    Args:
        text (str): the text to vectorize.
    """
    vector = [0.0] * len(_VOCAB)
    for stem in _stems(text):
        index = _VOCAB.get(stem)
        if index is not None:
            vector[index] += 1
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def build_collection(
    client: QdrantClient, collection: str = "fashion"
) -> None:
    """(Re)create a product collection with flat, low-cardinality payloads.

    Args:
        client (QdrantClient): the client to build with.
        collection (str): the collection to create, replacing any old one.
    """
    vectors = [embed(product["name"]) for product in _PRODUCTS]
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
    vectors = [embed(chunk["text"]) for chunk in _CHUNKS]
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

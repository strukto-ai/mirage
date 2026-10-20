// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { QdrantClient } from '@qdrant/js-client-rest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface Product {
  gender: string
  articleType: string
  baseColour: string
  name: string
}

// LangChain-style chunks whose lineage lives in a nested `metadata`
// payload: source document, page, text.
interface Chunk {
  source: string
  page: string
  text: string
}

// The rows both language examples seed, so the two mounts read alike.
const DATA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../data/qdrant.json', import.meta.url)), 'utf8'),
) as { products: Product[]; chunks: Chunk[] }
const PRODUCTS = DATA.products
const CHUNKS = DATA.chunks

// A bag of words over the corpus vocabulary stands in for a sentence
// model: a word's first five letters are its stem, so `refund` meets
// `refunds`, a query word the corpus never used is dropped, and the vector
// is unit length so cosine similarity is word overlap. A real model (the
// Python example runs fastembed's all-MiniLM-L6-v2) plugs into the same
// `embed` hook the mount config takes.
function stems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .map((word) => word.slice(0, 5))
}

const VOCAB = new Map<string, number>()
for (const text of [...PRODUCTS.map((p) => p.name), ...CHUNKS.map((c) => c.text)]) {
  for (const stem of stems(text)) if (!VOCAB.has(stem)) VOCAB.set(stem, VOCAB.size)
}

export function embed(text: string): number[] {
  const vector = new Array<number>(VOCAB.size).fill(0)
  for (const stem of stems(text)) {
    const index = VOCAB.get(stem)
    if (index !== undefined) vector[index] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1
  return vector.map((x) => x / norm)
}

async function recreate(qc: QdrantClient, collection: string, size: number): Promise<void> {
  if ((await qc.collectionExists(collection)).exists) await qc.deleteCollection(collection)
  await qc.createCollection(collection, { vectors: { size, distance: 'Cosine' } })
}

/** (Re)create a product collection with flat, low-cardinality payloads. */
export async function buildCollection(qc: QdrantClient, collection = 'fashion'): Promise<void> {
  const vectors = PRODUCTS.map((p) => embed(p.name))
  await recreate(qc, collection, vectors[0].length)
  const enc = new TextEncoder()
  await qc.upsert(collection, {
    wait: true,
    points: PRODUCTS.map((product, i) => ({
      id: i + 1,
      vector: vectors[i],
      payload: {
        gender: product.gender,
        articleType: product.articleType,
        baseColour: product.baseColour,
        productDisplayName: product.name,
        image_b64: Buffer.from(
          new Uint8Array([0xff, 0xd8, 0xff, ...enc.encode(product.name)]),
        ).toString('base64'),
      },
    })),
  })
  for (const field of ['gender', 'articleType', 'baseColour']) {
    await qc.createPayloadIndex(collection, { field_name: field, field_schema: 'keyword', wait: true })
  }
}

/** (Re)create a chunk collection whose payload nests the source document. */
export async function buildLineageCollection(
  qc: QdrantClient,
  collection = 'company_docs',
): Promise<void> {
  const vectors = CHUNKS.map((c) => embed(c.text))
  await recreate(qc, collection, vectors[0].length)
  await qc.upsert(collection, {
    wait: true,
    points: CHUNKS.map((chunk, i) => ({
      id: 101 + i,
      vector: vectors[i],
      payload: {
        page_content: chunk.text,
        metadata: { source: chunk.source, page: chunk.page },
      },
    })),
  })
  // Qdrant spells a nested payload path with a dot, in filters and in
  // index names alike; the mount config spells it the same way.
  await qc.createPayloadIndex(collection, {
    field_name: 'metadata.source',
    field_schema: 'keyword',
    wait: true,
  })
}

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

import { QdrantClient } from '@qdrant/js-client-rest'
import { MountMode, QdrantVFS, Workspace } from '@struktoai/mirage-node'
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
  readFileSync(fileURLToPath(new URL('../../data/qdrant.json', import.meta.url)), 'utf8'),
) as { products: Product[]; chunks: Chunk[] }
const PRODUCTS = DATA.products
const CHUNKS = DATA.chunks

type Embed = (texts: string[]) => Promise<number[][]>

// A bag of words over the corpus vocabulary stands in for a sentence
// model: a word's first five letters are its stem, so `refund` meets
// `refunds`, a query word the corpus never used is dropped, and the vector
// is unit length so cosine similarity is word overlap. A real model (the
// Python example runs fastembed's all-MiniLM-L6-v2) plugs into the same
// `embed` hook below.
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

function embed(text: string): number[] {
  const vector = new Array<number>(VOCAB.size).fill(0)
  for (const stem of stems(text)) {
    const index = VOCAB.get(stem)
    if (index !== undefined) vector[index] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1
  return vector.map((x) => x / norm)
}

const embedAll: Embed = (texts) => Promise.resolve(texts.map(embed))

function client(): QdrantClient {
  const url = process.env.QDRANT_URL
  if (url !== undefined) return new QdrantClient({ url, apiKey: process.env.QDRANT_API_KEY })
  return new QdrantClient({
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: Number(process.env.QDRANT_PORT ?? '6333'),
  })
}

async function recreate(qc: QdrantClient, collection: string, size: number): Promise<void> {
  if ((await qc.collectionExists(collection)).exists) await qc.deleteCollection(collection)
  await qc.createCollection(collection, { vectors: { size, distance: 'Cosine' } })
}

async function buildCollection(qc: QdrantClient, embed: Embed, collection: string): Promise<void> {
  const vectors = await embed(PRODUCTS.map((p) => p.name))
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

async function buildLineageCollection(
  qc: QdrantClient,
  embed: Embed,
  collection: string,
): Promise<void> {
  const vectors = await embed(CHUNKS.map((c) => c.text))
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

const DEC = new TextDecoder()

async function show(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n=== ${cmd} ===`)
  const r = await ws.shell(cmd)
  console.log(DEC.decode(r.stdout).trimEnd())
}

async function main(): Promise<void> {
  const qc = client()
  await buildCollection(qc, embedAll, 'fashion')
  await buildLineageCollection(qc, embedAll, 'company_docs')

  const connection = {
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: Number(process.env.QDRANT_PORT ?? '6333'),
    // `search` vectorizes its query through this hook, in-process, so a
    // self-hosted Qdrant with no inference works and mirage itself
    // depends on no model runtime.
    embed: (text: string): Promise<number[]> => Promise.resolve(embed(text)),
  }
  const fashion = new QdrantVFS({
    config: {
      ...connection,
      collection: 'fashion',
      groupBy: ['gender', 'articleType', 'baseColour'],
      idField: 'id',
      textField: 'productDisplayName',
      blobField: 'image_b64',
      blobExt: 'jpg',
      searchLimit: 4,
    },
  })
  // Chunks grouped by the document they came from: `metadata.source` is
  // a nested payload path, `basenameFields` lists it by file name, and
  // `nameField` puts the page label in front of the point id.
  const docs = new QdrantVFS({
    config: {
      ...connection,
      collection: 'company_docs',
      groupBy: ['metadata.source'],
      basenameFields: ['metadata.source'],
      nameField: 'metadata.page',
      textField: 'page_content',
      searchLimit: 2,
    },
  })
  const ws = new Workspace({ '/fashion/': fashion, '/docs/': docs }, { mode: MountMode.READ })

  console.log("=== mounted Qdrant collection 'fashion' at /fashion/ ===")

  await show(ws, 'ls /fashion/')
  await show(ws, 'tree -L 2 /fashion/')
  await show(ws, 'ls /fashion/Men/Shoes/White')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.txt')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.json')

  console.log('\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===')
  const s = await ws.shell("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
  console.log(`  image size: ${DEC.decode(s.stdout).trim()} bytes`)

  await show(ws, 'search "white running sneakers" /fashion')

  await show(ws, 'grep -ril blue /fashion/Women')
  await show(ws, 'rg -li running /fashion/Men')

  console.log("\n=== find /fashion -name '*.txt' | wc -l ===")
  const f = await ws.shell("find /fashion -name '*.txt' | wc -l")
  console.log(`  products: ${DEC.decode(f.stdout).trim()}`)

  console.log("\n=== mounted Qdrant collection 'company_docs' at /docs/ ===")
  // One directory per source document, named by its basename; each
  // chunk is `<page>__<point-id>.txt` beside its `.json` payload.
  await show(ws, 'tree /docs/')
  await show(ws, 'cat /docs/refund-2026.pdf/004__102.txt')
  await show(ws, 'cat /docs/refund-2026.pdf/004__102.json')
  await show(ws, 'search "how long does a refund take" /docs')

  await fashion.close()
  await docs.close()
}

void main()

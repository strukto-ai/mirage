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

import { connect } from '@lancedb/lancedb'
import { getRegistry, LanceSchema, TextEmbeddingFunction } from '@lancedb/lancedb/embedding'
import { Binary, Int32, Utf8 } from 'apache-arrow'

const FASHION_VOCAB = [
  'men', 'women', 'tshirt', 'shirt', 'jeans', 'shoes', 'sneakers', 'heels',
  'jacket', 'dress', 'blue', 'red', 'black', 'white', 'green', 'running',
  'casual', 'formal', 'sports', 'summer', 'winter',
]
const INDEX = new Map(FASHION_VOCAB.map((token, i) => [token, i]))

const PRODUCTS: [string, string, string, string][] = [
  ['Men', 'Tshirts', 'Blue', 'Roadster Men Blue Casual Tshirt'],
  ['Men', 'Tshirts', 'Black', 'HRX Men Black Sports Tshirt'],
  ['Men', 'Shoes', 'White', 'Nike Men White Running Sneakers'],
  ['Men', 'Shoes', 'Black', 'Puma Men Black Formal Shoes'],
  ['Men', 'Jeans', 'Blue', 'Levis Men Blue Casual Jeans'],
  ['Women', 'Tshirts', 'Red', 'Roadster Women Red Casual Tshirt'],
  ['Women', 'Shoes', 'Red', 'Steve Madden Women Red Heels'],
  ['Women', 'Shoes', 'White', 'Adidas Women White Running Sneakers'],
  ['Women', 'Dress', 'Black', 'Zara Women Black Formal Dress'],
  ['Women', 'Jeans', 'Blue', 'H&M Women Blue Summer Jeans'],
]

function embed(text: string): number[] {
  const vector = new Array<number>(FASHION_VOCAB.length).fill(0)
  for (const word of text.toLowerCase().split(/\s+/)) {
    const idx = INDEX.get(word.replace(/^[.,]+|[.,]+$/g, ''))
    if (idx !== undefined) vector[idx] = 1
  }
  const magnitude = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))
  const norm = magnitude === 0 ? 1 : magnitude
  return vector.map((x) => x / norm)
}

class KeywordEmbedding extends TextEmbeddingFunction {
  ndims(): number {
    return FASHION_VOCAB.length
  }
  toJSON(): Record<string, never> {
    return {}
  }
  generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(embed))
  }
}
getRegistry().register('fashion-keyword')(KeywordEmbedding)

export async function buildTable(uri: string, tableName = 'fashion'): Promise<void> {
  const create = getRegistry().get('fashion-keyword')
  if (create === undefined) throw new Error('fashion-keyword embedding not registered')
  const func = create.create() as KeywordEmbedding
  const schema = LanceSchema({
    id: new Int32(),
    gender: new Utf8(),
    articleType: new Utf8(),
    baseColour: new Utf8(),
    productDisplayName: func.sourceField(),
    image_bytes: new Binary(),
    vector: func.vectorField(),
  })
  const enc = new TextEncoder()
  const rows = PRODUCTS.map(([gender, articleType, baseColour, name], i) => ({
    id: i + 1,
    gender,
    articleType,
    baseColour,
    productDisplayName: name,
    image_bytes: new Uint8Array([0xff, 0xd8, 0xff, ...enc.encode(name)]),
  }))
  const db = await connect(uri)
  if ((await db.tableNames()).includes(tableName)) await db.dropTable(tableName)
  await db.createTable(tableName, rows, { schema })
}

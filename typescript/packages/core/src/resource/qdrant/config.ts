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

export interface QdrantConfig {
  url?: string
  host?: string
  port?: number
  https?: boolean
  apiKey?: string
  collection?: string
  groupBy?: string[]
  idField?: string
  textField?: string
  blobField?: string
  blobExt?: string
  vectorField?: string
  searchLimit?: number
  maxRows?: number
  embeddingModel?: string
}

export interface QdrantConfigResolved {
  url: string | null
  host: string
  port: number
  https: boolean
  apiKey: string | null
  collection: string | null
  groupBy: string[]
  idField: string
  textField: string | null
  blobField: string | null
  blobExt: string
  vectorField: string | null
  searchLimit: number
  maxRows: number
  embeddingModel: string
}

export function resolveQdrantConfig(config: QdrantConfig): QdrantConfigResolved {
  return {
    url: config.url ?? null,
    host: config.host ?? 'localhost',
    port: config.port ?? 6333,
    https: config.https ?? false,
    apiKey: config.apiKey ?? null,
    collection: config.collection ?? null,
    groupBy: config.groupBy ?? [],
    idField: config.idField ?? 'id',
    textField: config.textField ?? null,
    blobField: config.blobField ?? null,
    blobExt: config.blobExt ?? 'bin',
    vectorField: config.vectorField ?? null,
    searchLimit: config.searchLimit ?? 10,
    maxRows: config.maxRows ?? 1000,
    embeddingModel: config.embeddingModel ?? 'sentence-transformers/all-MiniLM-L6-v2',
  }
}

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

import { rstripSlash } from '../../utils/slash.ts'

export interface DifyConfig {
  apiKey: string
  baseUrl: string
  datasetId: string
  slugMetadataName?: string
  maxConcurrency?: number
  requestTimeout?: number
  retryAttempts?: number
  retryMaxDelay?: number
}

export interface DifyConfigResolved {
  apiKey: string
  baseUrl: string
  datasetId: string
  slugMetadataName: string
  maxConcurrency: number
  requestTimeout: number
  retryAttempts: number
  retryMaxDelay: number
}

function normalizeNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized === '') {
    throw new Error(`${field} cannot be empty`)
  }
  return normalized
}

function normalizePositive(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!(resolved > 0)) {
    throw new Error(`${field} must be positive`)
  }
  return resolved
}

export function resolveDifyConfig(config: DifyConfig): DifyConfigResolved {
  return {
    apiKey: config.apiKey,
    baseUrl: rstripSlash(config.baseUrl),
    datasetId: normalizeNonEmpty(config.datasetId, 'datasetId'),
    slugMetadataName: normalizeNonEmpty(config.slugMetadataName ?? 'slug', 'slugMetadataName'),
    maxConcurrency: normalizePositive(config.maxConcurrency, 10, 'maxConcurrency'),
    requestTimeout: normalizePositive(config.requestTimeout, 30, 'requestTimeout'),
    retryAttempts: normalizePositive(config.retryAttempts, 4, 'retryAttempts'),
    retryMaxDelay: normalizePositive(config.retryMaxDelay, 30, 'retryMaxDelay'),
  }
}

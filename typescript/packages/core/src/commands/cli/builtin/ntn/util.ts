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

import { HttpNotionTransport, type NotionTransport } from '../../../../core/notion/_client.ts'
import type { NotionConfig } from '../../../../core/notion/config.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'

const ENC = new TextEncoder()

export function notionTransport(config: unknown): NotionTransport {
  const cfg = config as NotionConfig
  return new HttpNotionTransport({
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl !== undefined && cfg.baseUrl !== '' ? { baseUrl: cfg.baseUrl } : {}),
  })
}

export function parseJsonFlag(value: unknown, flag: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'string') throw new Error(`${flag} must be a JSON string`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // One wording in both languages: the engines' own parse messages
    // ("Expecting value" vs "Unexpected token") can never agree.
    throw new Error(`${flag} must be valid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function usageError(err: unknown): CommandFnResult {
  const msg = err instanceof Error ? err.message : String(err)
  return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
}

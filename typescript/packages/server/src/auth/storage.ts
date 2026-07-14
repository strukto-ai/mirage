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

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mirageHome } from '../paths.ts'

export function defaultTokenFile(env: Record<string, string | undefined> = process.env): string {
  return join(mirageHome(env), 'auth_token')
}

export function readTokenFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf-8').trim()
}

export function ensureTokenFile(path: string): string {
  const existing = readTokenFile(path)
  if (existing !== undefined && existing.length > 0) return existing
  mkdirSync(dirname(path), { recursive: true })
  const token = randomBytes(32).toString('base64url')
  writeFileSync(path, token)
  chmodSync(path, 0o600)
  return token
}

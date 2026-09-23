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

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DatabricksProfile {
  host?: string
  token?: string
}

export function parseDatabricksCfg(content: string, profile: string): DatabricksProfile {
  const result: DatabricksProfile = {}
  let inSection = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      inSection = line.slice(1, -1).trim() === profile
      continue
    }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'host') result.host = value
    if (key === 'token') result.token = value
  }
  return result
}

export async function loadDatabricksProfile(profile: string): Promise<DatabricksProfile> {
  const cfgPath = process.env.DATABRICKS_CONFIG_FILE ?? join(homedir(), '.databrickscfg')
  let content: string
  try {
    content = await readFile(cfgPath, 'utf-8')
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return {}
    throw err
  }
  return parseDatabricksCfg(content, profile)
}

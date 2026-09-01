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

import { parse } from 'dotenv'

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'

import type { DotenvConfig } from './config.ts'

/**
 * Read one dotenv file as one secret: the file's key=value pairs as
 * fields. `ref` is the host filesystem path of the file; empty falls
 * back to `config.path`. A missing file is a SecretsError naming the
 * path. Values are taken verbatim: `dotenv.parse` never interpolates,
 * and Python passes `interpolate=False` to match, so a `${NAME}` in a
 * value stays literal in both languages instead of copying a host
 * variable into a secret.
 */
export async function fetchDotenv(config: DotenvConfig, ref: string): Promise<ResolvedSecret> {
  const path = ref !== '' ? ref : config.path
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch (caught) {
    if ((caught as { code?: string }).code === 'ENOENT') {
      throw new SecretsError(`dotenv file not found: ${path}`, { cause: caught })
    }
    throw caught
  }
  return { fields: parse(text) }
}

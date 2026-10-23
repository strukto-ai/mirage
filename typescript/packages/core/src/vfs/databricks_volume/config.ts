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

import { z } from 'zod'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  secretSchema,
} from '../secrets.ts'

function validVolumePart(value: string): boolean {
  return value !== '' && !value.includes('/')
}

function normalizeRootPath(value: string): string {
  const parts = value.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) {
    throw new Error("root_path must not contain '..' segments")
  }
  if (parts.length === 0) return '/'
  return '/' + parts.join('/')
}

/** Supplies each request's token for a fixed principal and permission scope.
 * The provider owns refresh coordination. Different identities require isolated
 * workspaces, caches, indexes, and external cache prefixes.
 */
export type TokenProvider = () => string | Promise<string>

function normalizeHost(value: string): string {
  if (/\s/.test(value) || /[?#\\]/.test(value)) {
    throw new Error('host must be an HTTP(S) origin')
  }
  let host: URL
  try {
    host = new URL(value)
  } catch {
    throw new Error('host must be an HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(host.protocol) ||
    host.username !== '' ||
    host.password !== '' ||
    host.search !== '' ||
    host.hash !== '' ||
    host.pathname !== '/'
  )
    throw new Error('host must be an HTTP(S) origin without credentials, path, query or fragment')
  return host.origin
}

function validToken(value: string): boolean {
  return value.trim() !== '' && !/[\r\n]/.test(value)
}

const DatabricksVolumeConfigSchema = z.object({
  catalog: z
    .string()
    .refine(validVolumePart, 'must be a non-empty path segment')
    .describe('Unity Catalog catalog name; one path segment, no `/`.'),
  schema: z
    .string()
    .refine(validVolumePart, 'must be a non-empty path segment')
    .describe('Unity Catalog schema name; one path segment, no `/`.'),
  volume: z
    .string()
    .refine(validVolumePart, 'must be a non-empty path segment')
    .describe('Unity Catalog volume name; one path segment, no `/`.'),
  rootPath: z
    .string()
    .transform(normalizeRootPath)
    .default('/')
    .describe(
      'Subdirectory inside the volume that becomes the mount root; `..` segments are refused.',
    ),
  host: z
    .string()
    .transform(normalizeHost)
    .describe(
      'Workspace origin, `http://` or `https://`, with no path, query, fragment or credentials.',
    ),
  token: secretSchema(
    z.union([
      z.string().refine(validToken, 'token must be nonblank without CR or LF'),
      z.custom<TokenProvider>((value) => typeof value === 'function'),
    ]),
  ).describe(
    'Bearer token as a string, or a function, synchronous or asynchronous, that returns one for each request.',
  ),
  timeout: z
    .number()
    .positive()
    .default(30)
    .describe('Seconds one request may take before it fails.'),
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
    default: 1000,
  }),
})

export type DatabricksVolumeConfig = ConfigOf<typeof DatabricksVolumeConfigSchema>

export type DatabricksVolumeConfigRedacted = RedactedConfig<DatabricksVolumeConfig, 'token'>

export function redactDatabricksVolumeConfig(
  config: DatabricksVolumeConfig,
): DatabricksVolumeConfigRedacted {
  return redactConfigWithSchema(
    DatabricksVolumeConfigSchema,
    config,
  ) as unknown as DatabricksVolumeConfigRedacted
}

export function normalizeDatabricksVolumeConfig(
  input: Record<string, unknown>,
): DatabricksVolumeConfig {
  return parseConfigWithSchema(DatabricksVolumeConfigSchema, input)
}

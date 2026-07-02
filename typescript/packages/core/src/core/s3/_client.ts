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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { S3Client } from '@aws-sdk/client-s3'
import type { PathSpec } from '../../types.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import * as kp from '../../utils/key_prefix.ts'
import type { S3Config } from '../../resource/s3/config.ts'

export function s3Key(path: string, config: S3Config): string {
  return kp.apply(config.keyPrefix ?? '', path)
}

export function s3Prefix(path: string, config: S3Config): string {
  return kp.applyDir(config.keyPrefix ?? '', path)
}

export function stripKeyPrefix(key: string, config: S3Config): string {
  return kp.strip(config.keyPrefix ?? '', key)
}

export function rawPathOf(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  return prefix !== '' && path.virtual.startsWith(prefix)
    ? path.virtual.slice(prefix.length) || '/'
    : path.virtual
}

export interface S3SendClient {
  send: (cmd: unknown) => Promise<Record<string, unknown>>
  destroy?: () => void
}

export async function withClient<T>(
  config: S3Config,
  fn: (client: S3SendClient) => Promise<T>,
): Promise<T> {
  const client = (await createS3Client(config)) as unknown as S3SendClient
  try {
    return await fn(client)
  } finally {
    client.destroy?.()
  }
}

export interface S3Module {
  S3Client: new (options: Record<string, unknown>) => S3Client
  GetObjectCommand: new (input: Record<string, unknown>) => unknown
  HeadObjectCommand: new (input: Record<string, unknown>) => unknown
  ListObjectsV2Command: new (input: Record<string, unknown>) => unknown
  PutObjectCommand: new (input: Record<string, unknown>) => unknown
  DeleteObjectCommand: new (input: Record<string, unknown>) => unknown
  DeleteObjectsCommand: new (input: Record<string, unknown>) => unknown
  CopyObjectCommand: new (input: Record<string, unknown>) => unknown
}

let cachedModule: Promise<S3Module> | null = null

/**
 * Load the S3 "command module" (GetObjectCommand etc.). When `config`
 * has a presignedUrlProvider — the browser runtime path — skip the AWS
 * SDK entirely and return a set of tagged data-only shim classes that
 * the browser-side client knows how to dispatch via fetch().
 *
 * Mirrors Python's `async_session(config)` abstraction: one seam,
 * two implementations (boto3 vs. presigner+fetch), same call surface.
 */
export async function loadS3Module(config?: S3Config): Promise<S3Module> {
  if (config?.presignedUrlProvider !== undefined) {
    const { BROWSER_S3_MODULE } = await import('./_client_browser.ts')
    return BROWSER_S3_MODULE
  }
  cachedModule ??= loadOptionalPeer(
    () => import('@aws-sdk/client-s3') as unknown as Promise<S3Module>,
    {
      feature: 'S3Resource',
      packageName: '@aws-sdk/client-s3',
      docsUrl: 'https://mirage.dev/typescript/install',
    },
  )
  return cachedModule
}

export async function createS3Client(config: S3Config): Promise<S3Client> {
  if (config.presignedUrlProvider !== undefined) {
    const { createBrowserS3Client } = await import('./_client_browser.ts')
    return createBrowserS3Client(config) as unknown as S3Client
  }
  const mod = await loadS3Module()
  const options: Record<string, unknown> = {}
  if (config.region !== undefined) options.region = config.region
  if (config.endpoint !== undefined) options.endpoint = config.endpoint
  if (config.forcePathStyle === true) options.forcePathStyle = true
  if (config.accessKeyId !== undefined && config.secretAccessKey !== undefined) {
    options.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    }
  }
  if (config.timeoutMs !== undefined) {
    options.requestHandler = {
      connectionTimeout: config.timeoutMs,
      requestTimeout: config.timeoutMs,
    }
  }
  return new mod.S3Client(options)
}

export function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string }
  if (e.name === 'NoSuchKey' || e.name === 'NotFound') return true
  if (e.Code === 'NoSuchKey' || e.Code === '404') return true
  return e.$metadata?.httpStatusCode === 404
}

export async function streamToBuffer(stream: unknown): Promise<Uint8Array> {
  if (stream === null || stream === undefined) return new Uint8Array()
  const s = stream as {
    transformToByteArray?: () => Promise<Uint8Array>
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
  }
  if (typeof s.transformToByteArray === 'function') {
    return s.transformToByteArray()
  }
  if (typeof s[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of s as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
      total += chunk.byteLength
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      out.set(c, offset)
      offset += c.byteLength
    }
    return out
  }
  throw new Error('S3 response Body is not a readable stream')
}

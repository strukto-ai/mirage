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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

import { S3Accessor } from '../../accessor/s3.ts'
import type { FsError } from '../../errors/types.ts'
import { PathSpec } from '../../types.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { sdkError } from '../../../tests/core/s3/_test_util.ts'
import { checksum } from './checksum.ts'
import { DRIVER } from './driver.ts'
import { read } from './read.ts'
import { readStream } from './stream.ts'
import type { S3Conn, S3Module } from './types.ts'

class HeadObjectCommand {
  constructor(readonly input: unknown) {}
}
class GetObjectCommand {
  constructor(readonly input: unknown) {}
}
class ListObjectsV2Command {
  constructor(readonly input: unknown) {}
}

// Every HEAD fails as `failure.head` names it and every request with a body
// as `failure.body`: a refusal is a bodiless Unknown on HEAD, AccessDenied else.
const failure = vi.hoisted(() => ({ head: 'Unknown', body: 'AccessDenied' }))

function refuse(cmd: unknown): Promise<never> {
  const name = cmd instanceof HeadObjectCommand ? failure.head : failure.body
  return Promise.reject(sdkError(name, 403))
}

vi.mock('./client.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ClientModule>()
  return {
    ...real,
    loadS3Module: () => Promise.resolve({ HeadObjectCommand, GetObjectCommand }),
    createS3Client: () => Promise.resolve({ send: refuse }),
  }
})

const SPEC = PathSpec.fromStrPath('/s3/k.txt', 'k.txt')
const accessor = new S3Accessor({ bucket: 'b', region: 'us-east-1' } as S3Config)
const conn = {
  config: { bucket: 'b' } as S3Config,
  mod: { HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } as unknown as S3Module,
  send: refuse,
} as S3Conn

async function drain(): Promise<void> {
  for await (const _chunk of readStream(accessor, SPEC)) void _chunk
}

// A driver door has only the key, which carries the mount's prefix, so it
// names nothing and the layer above names the operand.
const DOORS = [
  ['read', () => read(accessor, SPEC), '/s3/k.txt'],
  ['stream', drain, '/s3/k.txt'],
  ['checksum', () => checksum(accessor, SPEC, 'md5', true), '/s3/k.txt'],
  ['head', () => DRIVER.head(conn, 'k.txt'), undefined],
  ['get', () => DRIVER.getVersioned?.(conn, 'k.txt', null), undefined],
  ['move', () => DRIVER.moveFile?.(conn, 'k.txt', 'm.txt'), undefined],
  ['probe', () => DRIVER.probePrefix(conn, 'k/'), undefined],
] as const

async function failed(call: () => unknown): Promise<FsError | null> {
  return (call() as Promise<unknown>).then(
    () => null,
    (err: unknown) => err as FsError,
  )
}

afterEach(() => {
  failure.head = 'Unknown'
  failure.body = 'AccessDenied'
})

// Mirrors python's test_every_door_answers_a_refused_key_permission_denied.
describe('a refused key', () => {
  it.each(DOORS)('answers %s Permission denied', async (_door, call, named) => {
    const refused = await failed(call)
    expect(refused?.code).toBe('EACCES')
    expect(refused?.virtualPath).toBe(named)
  })
})

// Mirrors python's test_every_door_keeps_a_credential_failure_its_own.
describe('a credential failure', () => {
  it.each(DOORS)('stays its own at %s', async (_door, call) => {
    failure.head = 'SignatureDoesNotMatch'
    failure.body = 'SignatureDoesNotMatch'
    const err = await failed(call)
    expect(err?.name).toBe('SignatureDoesNotMatch')
    expect(err?.code).toBeUndefined()
  })
})

// Mirrors python's test_a_pinned_get_keeps_a_refusal_its_own. Only an unpinned
// get maps a refusal; a pinned one is a follow-up.
it('keeps a pinned get refusal its own', async () => {
  const err = await failed(() => DRIVER.getVersioned?.(conn, 'k.txt', 'v1'))
  expect(err?.name).toBe('AccessDenied')
  expect(err?.code).toBeUndefined()
})

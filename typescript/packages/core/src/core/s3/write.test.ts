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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, loadS3Module: vi.fn(), createS3Client: vi.fn() }
})

import { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { PathSpec } from '../../types.ts'
import * as clientMod from './client.ts'
import { write } from './write.ts'

class FakeCommand {
  constructor(readonly input: { Key?: string; ContentType?: string }) {}
}

function mockPut(keys: string[], types: (string | undefined)[] = []): void {
  vi.mocked(clientMod.loadS3Module).mockResolvedValue({
    PutObjectCommand: FakeCommand,
  } as never)
  vi.mocked(clientMod.createS3Client).mockResolvedValue({
    send: (command: FakeCommand) => {
      keys.push(command.input.Key ?? '')
      types.push(command.input.ContentType)
      return Promise.resolve({})
    },
  } as never)
}

async function runWrite(
  mountPath: string,
  config: Partial<S3Config> = {},
): Promise<{ keys: string[]; types: (string | undefined)[] }> {
  const keys: string[] = []
  const types: (string | undefined)[] = []
  mockPut(keys, types)
  const accessor = new S3Accessor({ bucket: 'b', ...config } as S3Config)
  const spec = new PathSpec({
    vfsPath: mountPath.replace(/^\//, ''),
    virtual: `/mnt${mountPath}`,
    directory: '/mnt/',
  })
  await write(accessor, spec, new TextEncoder().encode('hi'))
  return { keys, types }
}

describe('s3 core write', () => {
  beforeEach(() => {
    vi.mocked(clientMod.loadS3Module).mockReset()
    vi.mocked(clientMod.createS3Client).mockReset()
  })

  it.each([
    [{}, undefined],
    [{ defaultContentType: 'text/plain' }, 'text/plain'],
  ])('with %j sends content type %s', async (config, type) => {
    const { types } = await runWrite('/c.txt', config)
    expect(types).toEqual([type])
  })
})

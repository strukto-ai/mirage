import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import '../../io/spool.ts'
import { UPLOAD_CHUNK_SIZE } from './constants.ts'
import { write } from './write.ts'
import {
  FakeNextcloudOperator,
  installFakeOperator,
  ROOT,
} from '../../../tests/core/nextcloud/mock.ts'

const UPLOADS = 'https://cloud.example/remote.php/dav/uploads/user'

afterEach(() => {
  vi.unstubAllGlobals()
})

interface Sent {
  method: string
  url: string
  headers: unknown
  body: unknown
}

function setup(fail: string | null = null): {
  accessor: NextcloudAccessor
  fake: FakeNextcloudOperator
  sent: Sent[]
} {
  const accessor = new NextcloudAccessor({ url: `${ROOT}/`, username: 'user', password: 'pass' })
  const fake = new FakeNextcloudOperator()
  installFakeOperator(accessor, fake)
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    sent.push({ method, url, headers: init.headers, body: init.body })
    return Promise.resolve(new Response(null, { status: method === fail ? 500 : 201 }))
  })
  return { accessor, fake, sent }
}

describe('nextcloud write', () => {
  it('sends a small file in one PUT through opendal', async () => {
    const { accessor, fake, sent } = setup()
    await write(accessor, PathSpec.fromStrPath('/hello.txt'), new TextEncoder().encode('hi there'))
    expect(fake.files.get('hello.txt')?.toString()).toBe('hi there')
    expect(sent).toEqual([])
  })

  it('sends a large stream in chunks sliced from the spilled spool', async () => {
    const { accessor, fake, sent } = setup()
    const block = new Uint8Array(1024 * 1024)
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 64; i++) yield await Promise.resolve(block)
    }
    await write(accessor, PathSpec.fromStrPath('/d/big.bin'), source())
    const folder = sent[0]?.url ?? ''
    const target = { Destination: `${ROOT}/d/big.bin`, Authorization: `Basic ${btoa('user:pass')}` }
    const total = { ...target, 'OC-Total-Length': String(64 * block.byteLength) }
    const sizes = [...Array<number>(6).fill(UPLOAD_CHUNK_SIZE), 4 * block.byteLength]
    expect(folder.startsWith(`${UPLOADS}/mirage-`)).toBe(true)
    expect(sent.map(({ method, url, headers }) => [method, url, headers])).toEqual([
      ['MKCOL', folder, target],
      ...sizes.map((_, i) => ['PUT', `${folder}/${String(i + 1).padStart(5, '0')}`, total]),
      ['MOVE', `${folder}/.file`, total],
    ])
    const bodies = sent.filter((s) => s.method === 'PUT').map((s) => s.body)
    expect(bodies.every((body) => body instanceof Blob)).toBe(true)
    expect(bodies.map((body) => (body as Blob).size)).toEqual(sizes)
    expect([...fake.directories]).toEqual(['d/'])
    expect(fake.files.size).toBe(0)
  })

  it('deletes the upload folder when a step fails', async () => {
    const { accessor, sent } = setup('MOVE')
    await expect(
      write(accessor, PathSpec.fromStrPath('/big.bin'), new Uint8Array(UPLOAD_CHUNK_SIZE + 1)),
    ).rejects.toThrow('Nextcloud MOVE returned HTTP 500')
    expect(sent.map((s) => s.method)).toEqual(['MKCOL', 'PUT', 'PUT', 'MOVE', 'DELETE'])
    expect(sent.at(-1)?.url).toBe(sent[0]?.url)
  })
})

import { checkItem } from './paths.ts'
import { deltaTree, iterTree, writeItem } from './drive.ts'
import { OneDriveAccessor } from '../../accessor/onedrive.ts'
import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { mkdir as odMkdir } from '../onedrive/mkdir.ts'
import { unlink as odUnlink } from '../onedrive/unlink.ts'
import { rmR as odRmR } from '../onedrive/rm.ts'
import { mkdir as spMkdir } from '../sharepoint/mkdir.ts'
import { unlink as spUnlink } from '../sharepoint/unlink.ts'
import { rmR as spRmR } from '../sharepoint/rm.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { materialize } from '../../io/types.ts'
import { runWithRecording } from '../../observe/context.ts'
import { OneDriveVFS } from '../../vfs/onedrive/onedrive.ts'
import { SharePointVFS } from '../../vfs/sharepoint/sharepoint.ts'
import { PathSpec } from '../../types.ts'
import { resolveMsGraphConfig } from './config.ts'
import { DriveLoc, type DriveRef, type DriveUrl } from './drive.ts'

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'

const itemUrl: DriveUrl = (path, action = '') => {
  if (path === '') return `${BASE}/root${action}`
  const stem = `${BASE}/root:/${path}`
  return action !== '' ? `${stem}:${action}` : stem
}
const refPath: DriveRef = (folder = '') =>
  folder !== '' ? `/me/drive/root:/${folder}` : '/me/drive/root:'

function loc(path: string, drive = ''): DriveLoc {
  return new DriveLoc({ drive, path, virtual: `/od/${path}`, url: itemUrl, ref: refPath })
}

const config = resolveMsGraphConfig({ accessToken: 'tok' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('case aliases', () => {
  it.each(['SECRET.txt', 'Vault/secret.txt', 'Vault/new.txt'])(
    'never uploads through %s',
    async (key) => {
      const calls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: unknown, init?: RequestInit) => {
          const url = String(input)
          calls.push(init?.method ?? 'GET')
          const body =
            url === itemUrl('Vault')
              ? { name: 'vault', folder: {} }
              : { name: 'secret.txt', file: {}, size: 6 }
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }),
      )
      await expect(
        writeItem(config, loc(key), new TextEncoder().encode('changed')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(calls).not.toContain('PUT')
    },
  )
})

it.each(['mkdir', 'unlink', 'rmR'] as const)(
  'refuses provider %s through an aliased parent',
  async (operation) => {
    for (const provider of ['onedrive', 'sharepoint']) {
      const mutations: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn((input: unknown, init?: RequestInit) => {
          if ((init?.method ?? 'GET') !== 'GET') mutations.push(String(input))
          return Promise.resolve(
            new Response(JSON.stringify({ name: 'vault', folder: {} }), {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }),
      )
      const path = PathSpec.fromStrPath('/drive/Vault/secret.txt', 'Vault/secret.txt')
      const od = new OneDriveAccessor({ accessToken: 'test' })
      const sp = new SharePointAccessor({ accessToken: 'test', site: 's', drive: 'd' })
      sp.siteCache.set('s', 's1')
      sp.driveCache.set('s1\0d', 'd1')
      const run =
        provider === 'onedrive'
          ? () => ({ mkdir: odMkdir, unlink: odUnlink, rmR: odRmR })[operation](od, path)
          : () => ({ mkdir: spMkdir, unlink: spUnlink, rmR: spRmR })[operation](sp, path)
      await expect(run()).rejects.toMatchObject({ code: 'ENOENT' })
      expect(mutations).toEqual([])
    }
  },
)

it.each(['exact', 'missing', 'refused', 'root'])(
  'resolves %s with configured Graph roots',
  async (slot) => {
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = new URL(String(input))
        asked.push(url.pathname)
        const key = url.pathname.split('/root:/')[1] ?? ''
        const denied = slot === 'refused'
        const missing = slot === 'missing' && key.endsWith('/new')
        const body =
          denied || missing
            ? { error: { code: denied ? 'accessDenied' : 'itemNotFound', message: 'refused' } }
            : { name: key.slice(key.lastIndexOf('/') + 1), folder: {} }
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: denied ? 403 : missing ? 404 : 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }),
    )
    const key = slot === 'root' ? '' : 'vault/' + (slot === 'missing' ? 'new/child' : 'secret.txt')
    const target = new DriveLoc({
      drive: '',
      path: 'Configured/Root' + (key === '' ? '' : '/' + key),
      virtual: key,
      url: itemUrl,
      ref: refPath,
    })
    if (slot === 'refused')
      await expect(checkItem(config, target)).rejects.toMatchObject({ status: 403 })
    else expect((await checkItem(config, target)) === null).toBe(['missing', 'root'].includes(slot))
    expect(asked).toHaveLength(slot === 'root' ? 0 : slot === 'refused' ? 1 : 2)
  },
)

it('validates a tree scope once then walks canonical children', async () => {
  const metadata: string[] = []
  const listings: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input)
      const listing = url.endsWith(':/children')
      const depth = url.split('/nested').length - 1
      if (listing) listings.push(url)
      else metadata.push(url)
      const body = listing
        ? { value: depth < 10 ? [{ name: 'nested', folder: {} }] : [] }
        : { name: 'scope', folder: {} }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
  const entries = []
  for await (const entry of iterTree(config, loc('scope'))) entries.push(entry)
  expect(entries).toHaveLength(10)
  expect(listings).toHaveLength(11)
  expect(metadata).toEqual([itemUrl('scope')])
})

it('reuses validated leaf metadata for a delta listing', async () => {
  const metadata: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input)
      const entry = { id: 'S', name: 'scope', folder: {} }
      if (!url.endsWith(':/delta')) metadata.push(url)
      return Promise.resolve(
        new Response(JSON.stringify(url.endsWith(':/delta') ? { value: [entry] } : entry), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
  expect(await deltaTree(config, loc('scope'))).toEqual(new Map())
  expect(metadata).toEqual([itemUrl('scope')])
})

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'retains full virtual paths for recorded=%s streamed=%s alias reads',
  async (recorded, stream) => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        calls.push(new URL(String(input)).pathname)
        return Promise.resolve(
          new Response(JSON.stringify({ name: 'secret.txt', file: {} }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }),
    )
    const vfs = new OneDriveVFS({ accessToken: 'test' })
    const path = PathSpec.fromStrPath('/od/SECRET.txt', 'SECRET.txt')
    const read = async () => materialize(await vfs.read(path, undefined, 0, stream ? null : 1))
    await expect(recorded ? runWithRecording(read) : read()).rejects.toMatchObject({
      code: 'ENOENT',
      message: path.virtual,
    })
    expect(calls).toEqual(['/v1.0/me/drive/root:/SECRET.txt'])
  },
)

describe.each(['onedrive', 'sharepoint'] as const)('public %s alias error operands', (provider) => {
  it.each([
    'write',
    'create',
    'copy_source',
    'copy_destination',
    'rename_source',
    'rename_destination',
    'rmdir',
    'tree',
  ])('retains the complete operand before %s mutates anything', async (operation) => {
    const mutations: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        if (init?.method !== undefined && init.method !== 'GET') mutations.push(url.pathname)
        const name = url.pathname.split('/').at(-1)?.replace(/:$/, '') ?? ''
        return Promise.resolve(
          new Response(
            JSON.stringify({ name: name === 'SECRET.txt' ? 'secret.txt' : name, file: {} }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }),
    )
    const vfs =
      provider === 'onedrive'
        ? new OneDriveVFS({ accessToken: 'test' })
        : new SharePointVFS({ accessToken: 'test', site: 'Team', drive: 'Documents' })
    if (vfs instanceof OneDriveVFS) vfs.accessor.driveType = 'personal'
    else {
      vfs.accessor.siteCache.set('Team', 'site-id')
      vfs.accessor.driveCache.set('site-id\0Documents', 'drive-id')
    }
    const alias = PathSpec.fromStrPath('/mount/SECRET.txt', 'SECRET.txt')
    const publicPath = PathSpec.fromStrPath('/mount/public.txt', 'public.txt')
    const action = () => {
      if (operation === 'write') return vfs.write(alias, new TextEncoder().encode('changed'))
      if (operation === 'create') return vfs.create(alias)
      if (operation.startsWith('copy'))
        return vfs.copy(
          operation.endsWith('source') ? alias : publicPath,
          operation.endsWith('source') ? publicPath : alias,
        )
      if (operation.startsWith('rename'))
        return vfs.rename(
          operation.endsWith('source') ? alias : publicPath,
          operation.endsWith('source') ? publicPath : alias,
        )
      if (operation === 'rmdir') return vfs.rmdir(alias)
      return vfs.readTree(alias)
    }
    await expect(action()).rejects.toMatchObject({ code: 'ENOENT', message: alias.virtual })
    expect(mutations).toEqual([])
  })
})

it.each(['source', 'destination'])(
  'retains the complete %s child operand during a recursive public copy',
  async (side) => {
    const mutations: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input))
        if (init?.method === 'POST') {
          mutations.push(url.pathname)
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: 'nameAlreadyExists', message: 'occupied' } }),
              { status: 409, headers: { 'Content-Type': 'application/json' } },
            ),
          )
        }
        const key = url.pathname.split('/root:/')[1]?.replace(/:$/, '') ?? ''
        const name = key.split('/').at(-1) ?? ''
        const body = key.endsWith(':/children')
          ? { value: [{ name: 'child.txt', file: {} }] }
          : {
              name: key === `${side}/child.txt` ? 'CHILD.txt' : name,
              [key.includes('/') ? 'file' : 'folder']: {},
            }
        return Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
        )
      }),
    )
    const vfs = new OneDriveVFS({ accessToken: 'test' })
    await expect(
      vfs.copy(
        PathSpec.fromStrPath('/mount/source', 'source'),
        PathSpec.fromStrPath('/mount/destination', 'destination'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT', message: `/mount/${side}/child.txt` })
    expect(mutations).toEqual(['/v1.0/me/drive/root:/source:/copy'])
  },
)

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { FileChangeKind, PathSpec } from '../../types.ts'
import { statFingerprint } from '../../watch/fingerprint.ts'
import { buildDeltaHook } from './watch.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

// One file whose row a test mutates between pulls; the listing answers
// from it, so each pull sees the current cTag, eTag, stamp and size.
function drive() {
  const row = { cTag: 'c1', eTag: 'e1', lastModifiedDateTime: 'T1', size: 3 }
  const routes: Record<string, () => unknown> = {
    'https://graph.microsoft.com/v1.0/sites': () => ({ value: [{ id: 'site', name: 'team', displayName: 'Team' }] }),
    'https://graph.microsoft.com/v1.0/sites/site/drives': () => ({ value: [{ id: 'b!drive', name: 'Documents' }] }),
    'https://graph.microsoft.com/v1.0/drives/b!drive/root/children': () => ({ value: [{ id: 'i', name: 'a.txt', file: {}, ...row }] }),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | RequestInfo) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = decodeURIComponent(raw.split('?')[0] ?? raw)
      const route = routes[url]
      if (route === undefined) throw new Error(`unrouted ${url}`)
      return Promise.resolve(new Response(JSON.stringify(route())))
    }),
  )
  return row
}

describe('the sharepoint watch fingerprint', () => {
  it('ignores a metadata edit and reports a content write once', async () => {
    const row = drive()
    const hook = buildDeltaHook(new SharePointAccessor({ accessToken: 'token', site: 'Team', drive: 'Documents' }))
    const root = PathSpec.fromStrPath('/', '')
    const baseline = await hook.pull(root, null)
    // The walk stats each file from the listing it just made; that row has
    // to carry the cTag, or the fingerprint falls back to the stamp, which a
    // rename or property edit moves.
    Object.assign(row, { eTag: 'e2', lastModifiedDateTime: 'T2' })
    const touched = await hook.pull(root, baseline.checkpoint)
    Object.assign(row, { cTag: 'c3', eTag: 'e3', lastModifiedDateTime: 'T3', size: 12 })
    const written = await hook.pull(root, touched.checkpoint)
    expect(baseline.changes).toEqual([])
    expect(touched.changes).toEqual([])
    expect(written.changes.map((e) => [e.kind, e.path.virtual])).toEqual([
      [FileChangeKind.UPDATE, '/a.txt'],
    ])
    expect(written.changes[0]?.metadata?.fingerprint).toBe(statFingerprint('c3', 'T3', 12))
  })
})

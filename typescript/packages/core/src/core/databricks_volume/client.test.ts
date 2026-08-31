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
import { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { normalizeDatabricksVolumeConfig } from '../../resource/databricks_volume/config.ts'
import { dbxFetch, dbxUrl, encodeRemotePath } from './client.ts'
import { DatabricksVolumeApiError, DatabricksVolumeAuthError } from './errors.ts'

function makeAccessor(token = 'tok-123'): DatabricksVolumeAccessor {
  const config = normalizeDatabricksVolumeConfig({
    host: 'https://dbc.example.com/',
    token,
    catalog: 'main',
    schema: 'default',
    volume: 'agent_files',
  })
  return new DatabricksVolumeAccessor(config)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encodeRemotePath', () => {
  it('encodes segments but keeps slashes', () => {
    expect(encodeRemotePath('/Volumes/main/a b/c#d.txt')).toBe('/Volumes/main/a%20b/c%23d.txt')
  })
})

describe('dbxUrl', () => {
  it('builds files URLs from a slash-trimmed host', () => {
    const url = dbxUrl(makeAccessor(), 'files', '/Volumes/main/default/agent_files/a.txt')
    expect(url).toBe(
      'https://dbc.example.com/api/2.0/fs/files/Volumes/main/default/agent_files/a.txt',
    )
  })

  it('appends query parameters', () => {
    const url = dbxUrl(makeAccessor(), 'directories', '/Volumes/x', { page_token: 'abc' })
    expect(url).toBe('https://dbc.example.com/api/2.0/fs/directories/Volumes/x?page_token=abc')
  })
})

describe('dbxFetch', () => {
  it('sends bearer auth and returns the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await dbxFetch(makeAccessor(), 'GET', 'files', '/Volumes/x/a.txt')
    expect(await r.text()).toBe('ok')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dbc.example.com/api/2.0/fs/files/Volumes/x/a.txt')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
  })

  it('throws DatabricksVolumeApiError with parsed error_code on failure', async () => {
    const body = JSON.stringify({ error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'gone' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 404 })))
    const err = await dbxFetch(makeAccessor(), 'GET', 'files', '/Volumes/x/a.txt').catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DatabricksVolumeApiError)
    const apiErr = err as DatabricksVolumeApiError
    expect(apiErr.statusCode).toBe(404)
    expect(apiErr.errorCode).toBe('RESOURCE_DOES_NOT_EXIST')
    expect(apiErr.message).toContain('gone')
  })

  it('keeps non-JSON error bodies as the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('plain boom', { status: 500 })))
    const err = (await dbxFetch(makeAccessor(), 'DELETE', 'directories', '/Volumes/x').catch(
      (e: unknown) => e,
    )) as DatabricksVolumeApiError
    expect(err.statusCode).toBe(500)
    expect(err.errorCode).toBeNull()
    expect(err.message).toContain('plain boom')
  })
})

describe('dbxFetch token handling', () => {
  it('sends the configured token on every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const accessor = makeAccessor('tok-rotated')
    await dbxFetch(accessor, 'GET', 'files', '/Volumes/x/a.txt')
    await dbxFetch(accessor, 'GET', 'files', '/Volumes/x/a.txt')
    const first = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    const second = (fetchMock.mock.calls[1] as [string, RequestInit])[1]
    expect((first.headers as Record<string, string>).Authorization).toBe('Bearer tok-rotated')
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer tok-rotated')
  })

  it('reports a 401 as an auth error without replaying the request', async () => {
    // The token is the one the config carries, so a replay would send the
    // same refused credential again, and for a write it would send the write
    // twice. The application catches this, obtains a fresh token and builds a
    // new resource.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = (await dbxFetch(makeAccessor(), 'PUT', 'files', '/Volumes/x/a.txt', {
      body: new Uint8Array([1]),
    }).catch((e: unknown) => e)) as DatabricksVolumeAuthError
    expect(err).toBeInstanceOf(DatabricksVolumeAuthError)
    expect(err).toBeInstanceOf(DatabricksVolumeApiError)
    expect(err.statusCode).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a 403 as an ordinary api error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
    const err = (await dbxFetch(makeAccessor(), 'GET', 'files', '/Volumes/x/a.txt').catch(
      (e: unknown) => e,
    )) as DatabricksVolumeApiError
    expect(err).not.toBeInstanceOf(DatabricksVolumeAuthError)
    expect(err.statusCode).toBe(403)
  })
})

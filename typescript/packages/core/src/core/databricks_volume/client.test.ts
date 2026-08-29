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
import {
  StaticTokenProvider,
  type TokenProvider,
} from '../../resource/databricks_volume/token_provider.ts'
import { dbxFetch, dbxUrl, encodeRemotePath, resolveToken } from './client.ts'
import { DatabricksVolumeApiError } from './errors.ts'

function makeAccessor(provider?: TokenProvider): DatabricksVolumeAccessor {
  const config = normalizeDatabricksVolumeConfig({
    host: 'https://dbc.example.com/',
    catalog: 'main',
    schema: 'default',
    volume: 'agent_files',
  })
  return new DatabricksVolumeAccessor(config, provider ?? new StaticTokenProvider('tok-123'))
}

class RotatingTokenProvider implements TokenProvider {
  calls = 0
  constructor(private readonly tokens: string[]) {}
  getToken(): string {
    const token = this.tokens[Math.min(this.calls, this.tokens.length - 1)] ?? ''
    this.calls += 1
    return token
  }
}

class AsyncTokenProvider implements TokenProvider {
  calls = 0
  constructor(private readonly token: string) {}
  getToken(): Promise<string> {
    this.calls += 1
    return Promise.resolve(this.token)
  }
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

describe('resolveToken', () => {
  it('awaits an async provider', async () => {
    await expect(resolveToken(new AsyncTokenProvider('tok-async'))).resolves.toBe('tok-async')
  })

  it('refuses an empty token', async () => {
    await expect(resolveToken(new StaticTokenProvider(''))).rejects.toThrow('empty token')
  })
})

describe('dbxFetch token handling', () => {
  it('consults the provider again for each request, so a rotated token is used', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new RotatingTokenProvider(['tok-one', 'tok-two'])
    const accessor = makeAccessor(provider)
    await dbxFetch(accessor, 'GET', 'files', '/Volumes/x/a.txt')
    await dbxFetch(accessor, 'GET', 'files', '/Volumes/x/a.txt')
    expect(provider.calls).toBe(2)
    const first = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    const second = (fetchMock.mock.calls[1] as [string, RequestInit])[1]
    expect((first.headers as Record<string, string>).Authorization).toBe('Bearer tok-one')
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer tok-two')
  })

  it('awaits an async provider before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await dbxFetch(makeAccessor(new AsyncTokenProvider('tok-async')), 'GET', 'files', '/Volumes/x')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-async')
  })

  it('refuses an empty token before any request is sent', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      dbxFetch(makeAccessor(new StaticTokenProvider('')), 'GET', 'files', '/Volumes/x'),
    ).rejects.toThrow('empty token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('propagates a 401 without replaying the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = (await dbxFetch(makeAccessor(), 'PUT', 'files', '/Volumes/x/a.txt', {
      body: new Uint8Array([1]),
    }).catch((e: unknown) => e)) as DatabricksVolumeApiError
    expect(err.statusCode).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

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

import { describe, expect, it } from 'vitest'
import {
  GOOGLE_CREDENTIAL_ERROR,
  GoogleConfigSchema,
  normalizeGoogleConfig,
  redactGoogleConfig,
} from './config.ts'
import { GCalConfigSchema, normalizeGCalConfig } from '../../resource/gcal/config.ts'
import { REDACTED_SECRET } from '../../resource/secrets.ts'

describe('GoogleConfig', () => {
  it('accepts the refresh-token grant from snake_case', () => {
    const config = normalizeGoogleConfig({
      client_id: 'id',
      client_secret: 'secret',
      refresh_token: 'token',
    })
    expect(config).toEqual({ clientId: 'id', clientSecret: 'secret', refreshToken: 'token' })
  })

  it('omits the client secret for a PKCE flow', () => {
    const config = normalizeGoogleConfig({ client_id: 'id', refresh_token: 'token' })
    expect(config.clientSecret).toBeUndefined()
  })

  // A service account can mint an access token but has no refresh token,
  // so before this the only way in was to monkeypatch the refresh grant.
  it('accepts a standalone access token, literal or provider', () => {
    expect(normalizeGoogleConfig({ access_token: 'sa-token' }).accessToken).toBe('sa-token')
    const provider = (): string => 'sa-token'
    expect(normalizeGoogleConfig({ access_token: provider }).accessToken).toBe(provider)
  })

  // Mirrors python's `_one_credential`: refused at the door, not on the
  // first read.
  it('refuses a config naming no credential', () => {
    expect(() => normalizeGoogleConfig({ api_base: 'http://localhost:1' })).toThrow(
      GOOGLE_CREDENTIAL_ERROR,
    )
  })

  it('refuses a wrong-typed field instead of casting it through', () => {
    expect(() => normalizeGoogleConfig({ client_id: 7, refresh_token: 'token' })).toThrow(
      /clientId/,
    )
  })

  it('keeps refreshFn through parse and redacts it with the other secrets', () => {
    const refreshFn = (): Promise<{ accessToken: string; expiresIn: number }> =>
      Promise.resolve({ accessToken: 'proxy-tok', expiresIn: 3600 })
    const config = normalizeGoogleConfig({ client_id: 'id', refresh_token: 'token', refreshFn })
    expect(config.refreshFn).toBe(refreshFn)
    expect(redactGoogleConfig(config)).toEqual({
      clientId: 'id',
      refreshToken: REDACTED_SECRET,
      refreshFn: REDACTED_SECRET,
    })
  })

  it('redacts a provider the same as a literal token', () => {
    expect(redactGoogleConfig({ accessToken: () => 'tok' }).accessToken).toBe(REDACTED_SECRET)
    expect(redactGoogleConfig({ accessToken: 'tok' }).accessToken).toBe(REDACTED_SECRET)
  })

  // Python scopes time_zone / min_access_role / today to GCalConfig, and a
  // drive or docs mount has no use for them; hoisting them onto the base let
  // every Google mount accept a time zone that meant nothing to it.
  it('keeps the calendar knobs off the shared base and on GCalConfig', () => {
    expect(Object.keys(GoogleConfigSchema.shape)).not.toContain('timeZone')
    expect(Object.keys(GCalConfigSchema.shape)).toEqual(
      expect.arrayContaining(['timeZone', 'minAccessRole', 'today']),
    )
    const drive = normalizeGoogleConfig({ access_token: 'tok', time_zone: 'UTC' })
    expect(drive).not.toHaveProperty('timeZone')
    const calendar = normalizeGCalConfig({
      access_token: 'tok',
      time_zone: 'UTC',
      min_access_role: 'writer',
      today: '2026-01-01',
    })
    expect(calendar).toMatchObject({
      timeZone: 'UTC',
      minAccessRole: 'writer',
      today: '2026-01-01',
    })
    // `safeExtend` keeps the base's credential check.
    expect(() => normalizeGCalConfig({ time_zone: 'UTC' })).toThrow(GOOGLE_CREDENTIAL_ERROR)
  })
})

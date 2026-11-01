import { describe, expect, it } from 'vitest'
import { parseConfigWithSchema, redactConfigWithSchema } from '../vfs/secrets.ts'
import { OneDriveAccessor, OneDriveConfig } from './onedrive.ts'
import { SharePointConfig } from './sharepoint.ts'

describe('OneDrive config', () => {
  it('rejects two drive targets', () => {
    // A fixed precedence would silently address one and ignore the other.
    expect(() => new OneDriveAccessor({ accessToken: 'token', driveId: 'd', siteId: 's' })).toThrow(
      /names 2 drives \(driveId, siteId\)/,
    )
  })
})

describe('Microsoft Graph config schema', () => {
  it('accepts a provider callable for accessToken and keeps it secret', () => {
    const provider = () => 'minted'
    const config = parseConfigWithSchema(OneDriveConfig, {
      access_token: provider,
      drive_id: 'drive',
    })

    expect(config.accessToken).toBe(provider)
    expect(redactConfigWithSchema(OneDriveConfig, config)).toEqual({
      accessToken: '<REDACTED>',
      driveId: 'drive',
    })
  })

  it('camelCases snake_case input and rejects a wrong-typed field', () => {
    expect(
      parseConfigWithSchema(SharePointConfig, { access_token: 't', site_filter: 'Team' }),
    ).toEqual({
      accessToken: 't',
      siteFilter: 'Team',
    })
    expect(() =>
      parseConfigWithSchema(SharePointConfig, { access_token: 't', max_retries: 'many' }),
    ).toThrow()
    expect(() => parseConfigWithSchema(SharePointConfig, { site: 'Team' })).toThrow()
  })

  it('redacts the token whether it is a literal or a provider', () => {
    expect(
      redactConfigWithSchema(SharePointConfig, { accessToken: 'literal', site: 'Team' }),
    ).toEqual({
      accessToken: '<REDACTED>',
      site: 'Team',
    })
    expect(redactConfigWithSchema(SharePointConfig, { accessToken: () => 'minted' })).toEqual({
      accessToken: '<REDACTED>',
    })
  })
})

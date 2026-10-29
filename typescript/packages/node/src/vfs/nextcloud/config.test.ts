import { describe, expect, it } from 'vitest'
import { NextcloudConfigSchema } from './config.ts'
import { parseConfigWithSchema, redactConfigWithSchema } from '@struktoai/mirage-core/vfs/secrets'

describe('NextcloudConfig', () => {
  it('normalizes snake_case from YAML', () => {
    expect(
      parseConfigWithSchema(NextcloudConfigSchema, {
        url: 'https://cloud.example/remote.php/dav/files/alice/',
        username: 'alice',
        password: 'secret',
        verify_ssl: false,
        timeout: 15,
      }),
    ).toEqual({
      url: 'https://cloud.example/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'secret',
      verifySsl: false,
      timeout: 15,
    })
  })

  it('requires a URL', () => {
    expect(() => parseConfigWithSchema(NextcloudConfigSchema, {})).toThrow('non-empty url')
  })

  it('redacts the password', () => {
    expect(
      redactConfigWithSchema(NextcloudConfigSchema, {
        url: 'https://cloud.example/remote.php/dav/files/alice/',
        username: 'alice',
        password: 'secret',
      }),
    ).toEqual({
      url: 'https://cloud.example/remote.php/dav/files/alice/',
      username: 'alice',
      password: '<REDACTED>',
    })
  })
})

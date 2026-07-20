import { describe, expect, it } from 'vitest'
import { normalizeNextcloudConfig, redactNextcloudConfig } from './config.ts'

describe('NextcloudConfig', () => {
  it('normalizes snake_case from YAML', () => {
    expect(
      normalizeNextcloudConfig({
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
    expect(() => normalizeNextcloudConfig({})).toThrow('non-empty url')
  })

  it('redacts the password', () => {
    expect(
      redactNextcloudConfig({
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

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

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_KEYS,
  DaemonConfigError,
  parseDaemonTable,
  readDaemonTable,
  validateDaemonTable,
} from './daemon_config.ts'

describe('parseDaemonTable', () => {
  it('parses a [daemon] text block', () => {
    expect(parseDaemonTable('[daemon]\nurl = "http://127.0.0.1:9999"\n')).toEqual({
      url: 'http://127.0.0.1:9999',
    })
  })

  it('returns {} for text with no [daemon] section', () => {
    expect(parseDaemonTable('[other]\nfoo = "bar"\n')).toEqual({})
  })

  it('unescapes backslashes in quoted values', () => {
    expect(parseDaemonTable('[daemon]\nsocket = "C:\\\\pipes"\n').socket).toBe('C:\\pipes')
  })

  it('unescapes escaped quotes in quoted values', () => {
    expect(parseDaemonTable('[daemon]\nfoo = "a\\"b"\n').foo).toBe('a"b')
  })

  it('refuses an escape that is not a Unicode scalar value', () => {
    for (const bad of ['\\U00110000', '\\uD800']) {
      expect(() => parseDaemonTable(`[daemon]\nk = "${bad}"\n`)).toThrow(DaemonConfigError)
    }
  })

  it('reads the escapes of a TOML basic string as tomllib does', () => {
    expect(parseDaemonTable('[daemon]\nk = "a\\nb\\tc\\r\\u00e9\\U0001F600\\\\n"\n').k).toBe(
      'a\nb\tc\r\u00e9\u{1F600}\\n',
    )
  })
})

describe('readDaemonTable', () => {
  it('returns {} when the file is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-'))
    expect(readDaemonTable(home)).toEqual({})
  })

  it('reads [daemon] keys, stripping quotes', () => {
    const home = mkdtempSync(join(tmpdir(), 'mir-'))
    writeFileSync(join(home, 'config.toml'), '[daemon]\nsocket = "/tmp/s.sock"\n')
    expect(readDaemonTable(home).socket).toBe('/tmp/s.sock')
  })
})

describe('validateDaemonTable', () => {
  it('accepts known keys', () => {
    expect(() => {
      validateDaemonTable({ url: 'http://h:1', idle_grace_seconds: '45' })
    }).not.toThrow()
  })

  it('accepts the server operation keys', () => {
    expect(() => {
      validateDaemonTable({
        rate_limits: 'ip=1000/minute',
        forwarded_allow_ips: '10.0.0.0/8',
        max_sessions: '16',
        graceful_timeout: '25',
      })
    }).not.toThrow()
    expect(() => {
      validateDaemonTable({ graceful_timeout: 'soon' })
    }).toThrow(/graceful_timeout/)
  })

  it('rejects unknown keys naming them', () => {
    expect(() => {
      validateDaemonTable({ typo_key: 'x', url: 'http://h:1' })
    }).toThrow(/typo_key/)
  })

  it('names the new key for a renamed one', () => {
    expect(() => {
      validateDaemonTable({ jwt_clock_skew: '9', typo_key: 'x' })
    }).toThrow(
      new DaemonConfigError(
        'config.toml: `daemon.jwt_clock_skew` is now `daemon.jwt_clock_skew_seconds`; rename the key',
      ),
    )
  })

  it('accepts the jwt keys', () => {
    validateDaemonTable({ jwt_clock_skew_seconds: '9', jwt_pubkey: '-----BEGIN' })
    expect(() => {
      validateDaemonTable({ jwt_clock_skew_seconds: 'soon' })
    }).toThrow(/jwt_clock_skew_seconds/)
  })

  it('throws DaemonConfigError instances', () => {
    expect(() => {
      validateDaemonTable({ typo_key: 'x' })
    }).toThrow(DaemonConfigError)
  })

  it('rejects a non-numeric idle_grace_seconds', () => {
    expect(() => {
      validateDaemonTable({ idle_grace_seconds: 'soon' })
    }).toThrow(/idle_grace_seconds/)
  })

  it('exposes the shared key registry', () => {
    expect(ALLOWED_KEYS.has('port')).toBe(true)
    expect(ALLOWED_KEYS.has('MIRAGE_HOME')).toBe(false)
  })
})

describe('parseDaemonTable malformed lines', () => {
  it('throws on a non key=value line inside [daemon]', () => {
    expect(() => {
      parseDaemonTable('[daemon]\nnot toml\n')
    }).toThrow(/malformed/)
  })

  it('ignores junk outside [daemon]', () => {
    expect(parseDaemonTable('junk line\n[daemon]\nurl = "http://h:1"\n')).toEqual({
      url: 'http://h:1',
    })
  })
})

describe('parseDaemonTable unclosed section header', () => {
  it('throws on a [ line without a closing bracket', () => {
    expect(() => {
      parseDaemonTable('[daemon\nnot toml\n')
    }).toThrow(/malformed/)
  })
})

describe('network', () => {
  it('is left to each workspace', () => {
    expect(() => {
      validateDaemonTable({ network: 'false' })
    }).toThrow(/network/)
  })
})

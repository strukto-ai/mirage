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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configuredEndpoint } from './profile.ts'

const NAMES = [
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_PROFILE',
  'HOME',
]
const MINIO = 'http://minio.local:9000'
const ENDPOINT = `endpoint_url = ${MINIO}`

describe('configuredEndpoint', () => {
  const saved = new Map(NAMES.map((n) => [n, process.env[n]]))
  let home = ''
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, n)
      else process.env[n] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it.each([
    [
      'a nested block ends at an unindented key',
      {},
      `[default]\ns3 =\n  addressing_style = path\n${ENDPOINT}\n`,
      '',
      MINIO,
    ],
    ['the credentials file', {}, '', `[default]\n${ENDPOINT}\n`, MINIO],
    [
      '[profile default] replaces [default]',
      {},
      `[default]\n${ENDPOINT}\n[profile default]\nregion = x\n`,
      '',
      undefined,
    ],
    [
      'a section without a known prefix',
      { AWS_PROFILE: 'dev' },
      `[dev]\n${ENDPOINT}\n`,
      '',
      undefined,
    ],
    [
      'a prefix needs one space',
      { AWS_PROFILE: 'dev' },
      `[profile  dev]\n${ENDPOINT}\n`,
      '',
      undefined,
    ],
    [
      'a __proto__ section refuses the file',
      {},
      `[default]\n${ENDPOINT}\n[__proto__]\n${ENDPOINT}\n`,
      '',
      undefined,
    ],
    [
      'an ignore flag of false',
      { AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false' },
      `[default]\n${ENDPOINT}\n`,
      '',
      MINIO,
    ],
  ] as const)('%s', (_name, env, config, credentials, expected) => {
    for (const n of NAMES) Reflect.deleteProperty(process.env, n)
    home = mkdtempSync(join(tmpdir(), 'mirage-aws-'))
    process.env.HOME = home
    writeFileSync(join(home, 'config'), config)
    writeFileSync(join(home, 'credentials'), credentials)
    process.env.AWS_CONFIG_FILE = join(home, 'config')
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(home, 'credentials')
    for (const [n, v] of Object.entries(env)) process.env[n] = v
    expect(configuredEndpoint()).toBe(expected)
    expect(({} as Record<string, unknown>).endpoint_url).toBeUndefined()
  })

  it.each([
    ['a path under ~/', '~/cfg'],
    ['an empty variable, the default path', ''],
    ['a path it cannot read', 'DIR'],
  ] as const)('reads the config file at %s', (name, variable) => {
    for (const n of NAMES) Reflect.deleteProperty(process.env, n)
    home = mkdtempSync(join(tmpdir(), 'mirage-aws-'))
    process.env.HOME = home
    mkdirSync(join(home, '.aws'))
    writeFileSync(join(home, 'cfg'), `[default]\n${ENDPOINT}\n`)
    writeFileSync(join(home, '.aws', 'config'), `[default]\n${ENDPOINT}\n`)
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(home, 'none')
    process.env.AWS_CONFIG_FILE = variable === 'DIR' ? home : variable
    expect(configuredEndpoint(), name).toBe(variable === 'DIR' ? undefined : MINIO)
  })
})

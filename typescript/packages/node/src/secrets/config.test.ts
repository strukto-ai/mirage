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

import { AWSSMConfig, DotenvConfig, EnvConfig, OnePasswordConfig } from './config.ts'

describe('source configs', () => {
  it('all of them parse from ambient defaults', () => {
    expect(EnvConfig.parse({})).toEqual({})
    expect(DotenvConfig.parse({})).toEqual({ path: '.env' })
    expect(AWSSMConfig.parse({})).toEqual({})
    expect(OnePasswordConfig.parse({})).toEqual({})
  })

  it('each refuses an unknown key', () => {
    expect(() => EnvConfig.parse({ bogus: 1 })).toThrowError()
    expect(() => DotenvConfig.parse({ bogus: 1 })).toThrowError()
    expect(() => AWSSMConfig.parse({ bogus: 1 })).toThrowError()
    expect(() => OnePasswordConfig.parse({ bogus: 1 })).toThrowError()
  })

  it('1password takes a service account token', () => {
    expect(OnePasswordConfig.parse({ token: 'ops_x' })).toEqual({ token: 'ops_x' })
  })

  it('aws-sm carries the five shared auth fields', () => {
    const cfg = AWSSMConfig.parse({
      region: 'us-east-1',
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: 'sk',
      awsSessionToken: 'st',
      awsProfile: 'dev',
    })
    expect(cfg.region).toBe('us-east-1')
    expect(cfg.awsProfile).toBe('dev')
  })

  it('aws-sm refuses both spellings of one field', () => {
    // Insertion order would otherwise decide which credential wins,
    // and the two hosts would disagree; python refuses the same config
    // from the other side, its camel key being the extra one there.
    expect(() =>
      AWSSMConfig.parse({ aws_profile: 'from-yaml', awsProfile: 'from-code' }),
    ).toThrowError(/aws_profile/)
  })

  // A `secrets:` block spells a source's config python's way, so this
  // schema has to answer to both spellings; only aws-sm has a field
  // long enough for the two to differ.
  it('aws-sm accepts the snake_case spellings yaml arrives in', () => {
    const cfg = AWSSMConfig.parse({
      region: 'us-east-2',
      aws_access_key_id: 'AKIA',
      aws_secret_access_key: 'sk',
      aws_session_token: 'st',
      aws_profile: 'dev',
    })
    expect(cfg).toEqual({
      region: 'us-east-2',
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: 'sk',
      awsSessionToken: 'st',
      awsProfile: 'dev',
    })
  })
})

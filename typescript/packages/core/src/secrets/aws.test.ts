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

import { fetchAwsSmSigned, sigv4 } from './aws.ts'
import { AWSSMConfig } from './config.ts'
import { SecretsError } from './errors.ts'

// AWS's Signature Version 4 test suite: its example credentials, and the
// signatures it publishes for `get-vanilla` and `post-vanilla`.
const SUITE = {
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
}

describe('sigv4', () => {
  it.each([
    ['GET', '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'],
    ['POST', '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b'],
  ])('signs the suite’s %s-vanilla as AWS does', async (method, signature) => {
    const headers = await sigv4({
      ...SUITE,
      method,
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
    })
    expect(headers).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        `SignedHeaders=host;x-amz-date, Signature=${signature}`,
    })
  })

  it('signs a session token’s header too', async () => {
    const headers = await sigv4({
      ...SUITE,
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      headers: {},
      body: '',
      sessionToken: 'session',
    })
    expect(headers['x-amz-security-token']).toBe('session')
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token,')
  })
})

describe('fetchAwsSmSigned', () => {
  const config = AWSSMConfig.parse({
    region: 'us-east-1',
    aws_access_key_id: 'AKIATEST',
    aws_secret_access_key: 'secret',
  })
  const sent: Request[] = []

  function answer(status: number, body: unknown): void {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      sent.push(new Request(url, init))
      return Promise.resolve(new Response(JSON.stringify(body), { status }))
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    sent.length = 0
  })

  it('reads a secret with one signed GetSecretValue, and no redirect followed', async () => {
    answer(200, { SecretString: '{"token":"t","user":"u"}' })
    const secret = await fetchAwsSmSigned(config, 'prod/github')
    expect(secret).toEqual({ fields: { token: 't', user: 'u' } })
    const [request] = sent
    expect(request?.url).toBe('https://secretsmanager.us-east-1.amazonaws.com/')
    expect(request?.method).toBe('POST')
    expect(request?.redirect).toBe('manual')
    expect(request?.headers.get('x-amz-target')).toBe('secretsmanager.GetSecretValue')
    expect(await request?.json()).toEqual({ SecretId: 'prod/github' })
    expect(request?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/us-east-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    )
  })

  it('reads a China region under its own partition’s domain', async () => {
    answer(200, { SecretString: 'plain' })
    const secret = await fetchAwsSmSigned({ ...config, region: 'cn-north-1' }, 'x')
    expect(secret).toEqual({ fields: { value: 'plain' } })
    expect(sent[0]?.url).toBe('https://secretsmanager.cn-north-1.amazonaws.com.cn/')
  })

  it('names the exception AWS answers with', async () => {
    answer(400, { __type: 'com.amazonaws.secretsmanager#ResourceNotFoundException' })
    await expect(fetchAwsSmSigned(config, 'gone')).rejects.toThrow(
      "aws-sm answered ResourceNotFoundException for 'gone'",
    )
  })

  it('refuses a binary secret', async () => {
    answer(200, { SecretBinary: 'AAAA' })
    await expect(fetchAwsSmSigned(config, 'bin')).rejects.toThrow(/binary/)
  })

  it.each([
    [{ ...config, awsProfile: 'dev' }, /can't read a profile/],
    [{ region: 'us-east-1' }, /needs region, aws_access_key_id and aws_secret_access_key/],
    [{ ...config, region: 'east' }, /region is an AWS region, got 'east'/],
  ])('refuses a config it can’t sign with, before any request', async (bad, message) => {
    answer(200, {})
    await expect(fetchAwsSmSigned(bad, 'x')).rejects.toThrow(message)
    await expect(fetchAwsSmSigned(bad, 'x')).rejects.toThrow(SecretsError)
    expect(sent).toEqual([])
  })

  it('needs a ref', async () => {
    await expect(fetchAwsSmSigned(config, '')).rejects.toThrow(/needs a ref/)
  })
})

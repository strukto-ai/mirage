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

import { createAppAuth } from '@octokit/auth-app'
import type { Octokit } from '@octokit/core'
import type { GitHubAppAuth } from './config.ts'

// An installation token lasts an hour. It is replaced five minutes before
// it expires, so a call that starts on an old token still finishes on it.
export const REFRESH_MARGIN = 300

/** A token and its expiry, in epoch seconds. */
export type MintedToken = [token: string, expires: number]

/**
 * The current installation token of one App installation, shared by every
 * account riding the same transport, so they mint one token between them.
 */
export class AppTokens {
  private current: MintedToken | null = null
  // One mint at a time: concurrent first calls wait for the token the first
  // one mints instead of each minting their own.
  private pending: Promise<string> | null = null

  constructor(readonly app: GitHubAppAuth) {}

  /**
   * The cached token, or a new one from `mint` when there is none or it is
   * within five minutes of expiring.
   *
   * Args:
   *   mint (() => Promise<MintedToken>): mints a token, returning it and its
   *     expiry in epoch seconds.
   */
  async token(mint: () => Promise<MintedToken>): Promise<string> {
    const current = this.current
    if (current !== null && Date.now() / 1000 < current[1] - REFRESH_MARGIN) return current[0]
    if (this.pending !== null) return this.pending
    this.pending = mint()
      .then((minted) => {
        this.current = minted
        return minted[0]
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }
}

const PKCS1_HEADER = '-----BEGIN RSA PRIVATE KEY-----'
const PKCS1_FOOTER = '-----END RSA PRIVATE KEY-----'
// AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }.
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]

/** A DER length: short form under 128, long form above. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256)
  return [0x80 | bytes.length, ...bytes]
}

/** A DER element: its tag, its length, then its content. */
function derElement(tag: number, content: ArrayLike<number>): number[] {
  return [tag, ...derLength(content.length), ...Array.from(content)]
}

/**
 * An App private key in the PKCS#8 form WebCrypto imports.
 *
 * GitHub downloads App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`). Octokit
 * converts one through `node:crypto`, which the browser and Cloudflare
 * Workers do not have, so the key is wrapped here instead: a PKCS#8
 * PrivateKeyInfo is version 0, the RSA algorithm, and the PKCS#1 key as an
 * octet string. Any other PEM is returned as it is.
 *
 * Args:
 *   pem (string): the key as configured; literal `\n` read as newlines.
 */
export function pkcs8Key(pem: string): string {
  const text = pem.replace(/\\n/g, '\n').trim()
  if (!text.startsWith(PKCS1_HEADER)) return text
  const body = text.slice(PKCS1_HEADER.length, text.indexOf(PKCS1_FOOTER)).replace(/\s+/g, '')
  const pkcs1 = Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
  const info = derElement(0x30, [
    ...derElement(0x02, [0x00]),
    ...RSA_ALGORITHM,
    ...derElement(0x04, pkcs1),
  ])
  let binary = ''
  for (const byte of info) binary += String.fromCharCode(byte)
  const lines = btoa(binary).match(/.{1,64}/g) ?? []
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----'].join('\n')
}

/**
 * The function that mints an installation token for `app`, narrowed to its
 * repositories and permissions when it names them, over `request`.
 *
 * Args:
 *   app (GitHubAppAuth): the App, its key and installation.
 *   request (Octokit['request']): an unauthenticated client on the API base.
 */
export function appMinter(
  app: GitHubAppAuth,
  request: Octokit['request'],
): () => Promise<MintedToken> {
  const auth = createAppAuth({
    appId: app.appId,
    privateKey: pkcs8Key(app.privateKey),
    installationId: app.installationId,
    request,
  })
  return async () => {
    // `refresh` skips octokit's own cache, which keeps a token 59 minutes:
    // AppTokens decides when a token is stale.
    const minted = await auth({
      type: 'installation',
      refresh: true,
      ...(app.repositories === undefined ? {} : { repositoryNames: app.repositories }),
      ...(app.permissions === undefined ? {} : { permissions: app.permissions }),
    })
    return [minted.token, Date.parse(minted.expiresAt) / 1000]
  }
}

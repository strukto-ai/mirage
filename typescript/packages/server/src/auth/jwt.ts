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

import {
  type JWTPayload,
  type JWTVerifyGetKey,
  decodeProtectedHeader,
  importSPKI,
  jwtVerify,
} from 'jose'

import type { JWTConfig } from './config.ts'

type VerifyKey = Awaited<ReturnType<typeof importSPKI>> | Uint8Array

export class JWTVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JWTVerificationError'
  }
}

async function loadKey(cfg: JWTConfig): Promise<VerifyKey> {
  if (cfg.key === undefined) throw new JWTVerificationError('no JWT key configured')
  if (cfg.algorithm.startsWith('HS')) {
    return new TextEncoder().encode(cfg.key)
  }
  return importSPKI(cfg.key, cfg.algorithm)
}

/**
 * Verify a JWT against `cfg` and return its claims. A token with `aud`
 * must name one of the configured audiences; one without must carry an
 * `azp` in the authorized parties when any are configured, and is refused
 * when only audiences are. So one server takes both an app's session
 * tokens (`azp`, no `aud`) and an OAuth client's access tokens (`aud`).
 * `keySet` checks the signature against the issuer's published keys;
 * without it, `cfg.key` does.
 */
export async function verifyJwt(
  token: string,
  cfg: JWTConfig,
  keySet?: JWTVerifyGetKey,
): Promise<JWTPayload> {
  let header: ReturnType<typeof decodeProtectedHeader>
  try {
    header = decodeProtectedHeader(token)
  } catch (e) {
    throw new JWTVerificationError(`JWT header unreadable: ${String(e)}`)
  }
  if (header.alg !== cfg.algorithm) {
    throw new JWTVerificationError(
      `JWT alg ${JSON.stringify(header.alg)} does not match configured ${JSON.stringify(cfg.algorithm)}`,
    )
  }
  if (header.typ !== undefined && header.typ !== 'JWT') {
    throw new JWTVerificationError(
      `JWT typ header must be "JWT" when present, got ${JSON.stringify(header.typ)}`,
    )
  }
  let payload: JWTPayload
  try {
    const verifyOpts: Parameters<typeof jwtVerify>[2] = {
      algorithms: [cfg.algorithm],
      requiredClaims: ['exp', 'sub'],
      clockTolerance: cfg.clockSkewSeconds,
    }
    if (cfg.issuer !== undefined) verifyOpts.issuer = cfg.issuer
    const result =
      keySet !== undefined
        ? await jwtVerify(token, keySet, verifyOpts)
        : await jwtVerify(token, await loadKey(cfg), verifyOpts)
    payload = result.payload
  } catch (e) {
    if (e instanceof JWTVerificationError) throw e
    throw new JWTVerificationError(`JWT rejected: ${String(e)}`)
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') {
    throw new JWTVerificationError('JWT sub must name an account')
  }
  const aud = payload.aud
  if (aud !== undefined) {
    const named = typeof aud === 'string' ? [aud] : aud
    if (!named.some((a) => cfg.audiences.includes(a))) {
      throw new JWTVerificationError(`JWT aud ${JSON.stringify(aud)} not in audiences`)
    }
  } else if (cfg.authorizedParties.length > 0) {
    const azp = payload.azp
    if (typeof azp !== 'string' || !cfg.authorizedParties.includes(azp)) {
      throw new JWTVerificationError(`JWT azp ${JSON.stringify(azp)} not in authorized_parties`)
    }
  } else if (cfg.audiences.length > 0) {
    throw new JWTVerificationError('JWT has no aud')
  }
  return payload
}

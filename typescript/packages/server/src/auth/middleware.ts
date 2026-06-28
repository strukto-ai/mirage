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

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

import { AuthMode, type AuthConfig } from './config.ts'
import { JWTVerificationError, verifyJwt } from './jwt.ts'

const BEARER_PREFIX = 'Bearer '
const HEALTH_PATHS = new Set(['/v1/health'])
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const AUTH_RATE_LIMIT_POINTS = 2000
const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function extractBearer(req: FastifyRequest): string | undefined {
  const raw = req.headers.authorization
  if (typeof raw !== 'string' || !raw.startsWith(BEARER_PREFIX)) return undefined
  const value = raw.slice(BEARER_PREFIX.length).trim()
  return value.length > 0 ? value : undefined
}

async function unauthorized(reply: FastifyReply, reason: string): Promise<void> {
  reply.header('WWW-Authenticate', 'Bearer')
  console.warn(`rejecting request from ${reply.request.ip}: ${reason}`)
  await reply.code(401).send({ detail: 'Unauthorized' })
}

export function registerAuth(app: FastifyInstance, config: AuthConfig): void {
  if (config.mode === AuthMode.Local && config.localToken === undefined) {
    console.warn(
      'daemon starting without bearer auth; anyone who can reach it can drive it. ' +
        'Set MIRAGE_AUTH_TOKEN or use a non-local MIRAGE_AUTH_MODE to enforce authentication.',
    )
    return
  }
  const limiter = new RateLimiterMemory({
    points: AUTH_RATE_LIMIT_POINTS,
    duration: AUTH_RATE_LIMIT_WINDOW_SECONDS,
  })
  app.addHook('onRequest', async (req, reply) => {
    if (HEALTH_PATHS.has(req.url)) return
    try {
      await limiter.consume(req.ip)
    } catch (e) {
      if (e instanceof RateLimiterRes) {
        reply.header('Retry-After', String(Math.ceil(e.msBeforeNext / 1000)))
        console.warn(`rate-limiting request from ${req.ip}`)
        await reply.code(429).send({ detail: 'Too Many Requests' })
        return
      }
      throw e
    }
  })
  app.addHook('onRequest', async (req, reply) => {
    if (HEALTH_PATHS.has(req.url)) return
    const token = extractBearer(req)
    if (token === undefined) {
      await unauthorized(reply, 'missing bearer token')
      return
    }
    if (config.mode === AuthMode.Jwt) {
      if (config.jwt === undefined || !JWT_SHAPE.test(token)) {
        await unauthorized(reply, 'token shape is not a JWT')
        return
      }
      try {
        await verifyJwt(token, config.jwt)
      } catch (e) {
        const reason = e instanceof JWTVerificationError ? e.message : String(e)
        await unauthorized(reply, reason)
        return
      }
      return
    }
    const expected = config.mode === AuthMode.Local ? config.localToken : config.bearerToken
    if (expected === undefined || !constantTimeEqual(token, expected)) {
      await unauthorized(reply, 'bearer mismatch')
      return
    }
  })
}

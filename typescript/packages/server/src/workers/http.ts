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
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { COUNTED_HEADER } from '../rate_limit.ts'
import { HOP_BY_HOP } from './constants.ts'
import type { Answer } from './types.ts'

/** The decoded segments of a request's path, null if one is not percent-encoded. */
export function pathParts(url: string | undefined): string[] | null {
  const segments = new URL(url ?? '/', 'http://daemon').pathname.split('/').slice(1)
  try {
    return segments.map((segment) => decodeURIComponent(segment))
  } catch (error) {
    // Answered with a 400, unlogged: any caller can send one.
    if (error instanceof URIError) return null
    throw error
  }
}

/** Read the rest of a body answered without it, so its connection goes on. */
export function discard(req: IncomingMessage): void {
  if (req.readableEnded) return
  req.unpipe()
  req.resume()
}

/** The whole answer to `request`. */
export function answered(request: ClientRequest): Promise<Answer> {
  return new Promise((resolve, reject) => {
    request.once('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      })
      response.once('error', reject)
    })
    request.once('error', reject)
  })
}

export function headersFor(req: IncomingMessage, client: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    // Only the daemon says a request was counted.
    const own = name === 'x-forwarded-for' || name === COUNTED_HEADER
    if (!HOP_BY_HOP.has(name) && !own && value !== undefined) {
      headers[name] = value
    }
  }
  headers['x-forwarded-for'] = client
  return headers
}

export function passable(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) out[name] = value
  }
  return out
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

export function sendAnswer(res: ServerResponse, answer: Answer): void {
  const headers = passable(answer.headers)
  headers['content-length'] = answer.body.byteLength
  res.writeHead(answer.status, headers)
  res.end(answer.body)
}

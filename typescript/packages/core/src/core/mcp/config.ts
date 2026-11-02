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

import { z } from 'zod'
import type { ConfigOf } from '../../vfs/secrets.ts'
import { secretStr } from '../../vfs/secrets.ts'

export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
export const HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/**
 * How a request to the server authenticates: one header. `bearer` sends
 * `Authorization: Bearer <token>`; `header` sends `<name>: <token>`.
 *
 * One flat strict object, not a union: the snapshot redaction never walks a
 * union's members, so a union would save the token.
 */
export const MCPAuth = z
  .strictObject({
    type: z.enum(['bearer', 'header']),
    token: secretStr(),
    name: z.string().nullish(),
  })
  .superRefine((auth, ctx) => {
    if (!HEADER_VALUE.test(auth.token)) {
      ctx.addIssue({
        code: 'custom',
        path: ['token'],
        message: 'the token holds a character no header carries',
      })
    }
    if (auth.type === 'bearer' && (auth.name ?? null) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'bearer auth sends Authorization; it takes no name',
      })
    }
    if (auth.type === 'header') {
      if (auth.name === undefined || auth.name === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: "header auth needs the header's name",
        })
      } else if (!HEADER_NAME.test(auth.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: `'${auth.name}' is not a header name`,
        })
      }
    }
  })

export type MCPAuth = ConfigOf<typeof MCPAuth>

/** Where an MCP server is and how to authenticate to it; no auth for a public server. */
export const MCPConfig = z.strictObject({
  url: z.string(),
  auth: MCPAuth.nullish(),
})

export type MCPConfig = ConfigOf<typeof MCPConfig>

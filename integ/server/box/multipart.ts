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

import type { Ctx } from '../kit/typescript/index.ts'

export interface Part {
  text: string
  bytes: Uint8Array<ArrayBuffer>
}

// Box uploads are multipart, and so are Discord messages with attachments; the
// parsing is the runtime's rather than hand-rolled: Node's Request implements the same
// multipart reader fetch() uses, so what is decoded here is by construction
// what a real client's FormData encoded. Both mirage hosts build the body with
// FormData (TypeScript) and aiohttp.FormData (Python), and a hand-rolled
// scanner would have to agree with both boundary and header spellings.
export async function readMultipart<C>(ctx: Ctx<C>): Promise<Record<string, Part>> {
  const raw = ctx.headers['content-type']
  const contentType = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const req = new Request('http://kit.invalid/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    // A Buffer is a Uint8Array, but its ArrayBufferLike backing does not
    // satisfy BodyInit; the copy pins it to a plain ArrayBuffer.
    body: new Uint8Array(ctx.body),
  })
  const form = await req.formData()
  const out: Record<string, Part> = {}
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      out[name] = { text: value, bytes: new Uint8Array(Buffer.from(value, 'utf8')) }
      continue
    }
    const bytes = new Uint8Array(await value.arrayBuffer())
    out[name] = { text: new TextDecoder().decode(bytes), bytes }
  }
  return out
}

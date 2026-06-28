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

import { resolveQdrantConfig } from '../../resource/qdrant/config.ts'
import { renderJson, renderText } from './render.ts'

const DEC = new TextDecoder()

const config = resolveQdrantConfig({
  idField: 'id',
  textField: 'name',
  blobField: 'image_bytes',
  blobExt: 'png',
  vectorField: 'vector',
})

describe('qdrant render', () => {
  it('renderJson omits the vector and blob fields', () => {
    const out = DEC.decode(
      renderJson(
        {
          id: 3,
          name: 'a big brown dog',
          label: 'dog',
          image_bytes: 'UE5HLTM=',
          vector: [0.1, 0.2],
        },
        config,
      ),
    )
    const payload = JSON.parse(out) as Record<string, unknown>
    expect(payload).toEqual({ id: 3, name: 'a big brown dog', label: 'dog' })
    expect(out).not.toContain('vector')
    expect(out).not.toContain('UE5HLTM=')
  })

  it('renderJson is compact with a trailing newline', () => {
    const out = DEC.decode(renderJson({ id: 1, name: 'x' }, config))
    expect(out).toBe('{"id":1,"name":"x"}\n')
  })

  it('renderText returns the source text', () => {
    const out = DEC.decode(renderText({ id: 3, name: 'a big brown dog' }, config))
    expect(out).toBe('a big brown dog\n')
  })

  it('renderText is empty when the text field is missing', () => {
    expect(renderText({ id: 3 }, config).length).toBe(0)
  })
})

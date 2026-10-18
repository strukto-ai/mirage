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
import { makeEnv, NATIVE_BACKENDS } from '../../tests/commands/native_fixture.ts'

describe.each(NATIVE_BACKENDS)('native echo (%s backend)', (kind) => {
  it('echo basic matches native', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage('echo hello world')
      const n = await env.native('echo hello world')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -n matches native', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage('echo -n hello')
      const n = await env.native('/bin/echo -n hello')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -e newline matches native printf', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(String.raw`echo -e 'hello\nworld'`)
      const n = await env.native(String.raw`printf '%s\n' 'hello' 'world'`)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -e tab matches native printf', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(String.raw`echo -e 'col1\tcol2'`)
      const n = await env.native(String.raw`printf 'col1\tcol2\n'`)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -e backslash matches native printf', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(String.raw`echo -e 'a\\b'`)
      const n = await env.native(String.raw`printf 'a\\b\n'`)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -e carriage return matches native printf', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(String.raw`echo -e 'hello\rbye'`)
      const n = await env.native(String.raw`printf 'hello\rbye\n'`)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -e mixed matches native printf', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage(String.raw`echo -e 'a\tb\nc'`)
      const n = await env.native(String.raw`printf 'a\tb\nc\n'`)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('echo -e without escapes matches native printf', async () => {
    const env = makeEnv(kind)
    try {
      const m = await env.mirage('echo -e hello')
      const n = await env.native(String.raw`printf 'hello\n'`)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })
})

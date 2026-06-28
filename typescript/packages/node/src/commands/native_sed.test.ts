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
import { makeEnv, NATIVE_BACKENDS } from './native_fixture.ts'

const ENC = new TextEncoder()

describe.each(NATIVE_BACKENDS)('native sed (%s backend)', (kind) => {
  it('sed substitute matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\n')
      const m = await env.mirage('sed s/hello/bye/', data)
      const n = await env.native('sed s/hello/bye/', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed global substitute matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo boo\n')
      const m = await env.mirage('sed s/o/0/g', data)
      const n = await env.native('sed s/o/0/g', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed first-only substitute matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo boo\n')
      const m = await env.mirage('sed s/o/0/', data)
      const n = await env.native('sed s/o/0/', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed delete line by number matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage('sed 2d', data)
      const n = await env.native('sed 2d', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed delete by regex matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo\nbar\nfoo2\n')
      const m = await env.mirage('sed /foo/d', data)
      const n = await env.native('sed /foo/d', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed on file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('sed s/hello/bye/ /data/f.txt')
      const n = await env.native('sed s/hello/bye/ f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n suppress matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage('sed -n p', data)
      const n = await env.native('sed -n p', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n with address matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage('sed -n 2p', data)
      const n = await env.native('sed -n 2p', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n range matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\ne\n')
      const m = await env.mirage('sed -n 2,4p', data)
      const n = await env.native('sed -n 2,4p', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n regex address matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\nworld\nhello again\n')
      const m = await env.mirage('sed -n /hello/p', data)
      const n = await env.native('sed -n /hello/p', data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n on file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('a\nb\nc\nd\ne\n'))
      const m = await env.mirage('sed -n 2,3p /data/f.txt')
      const n = await env.native('sed -n 2,3p f.txt')
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -E extended regex matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo123bar\nhello\n')
      const m = await env.mirage("sed -E 's/[0-9]+/NUM/g'", data)
      const n = await env.native("sed -E 's/[0-9]+/NUM/g'", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -E groups matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\n')
      const m = await env.mirage("sed -E 's/(hello) (world)/\\2 \\1/'", data)
      const n = await env.native("sed -E 's/(hello) (world)/\\2 \\1/'", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed -nE combined matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('abc123\ndef\nghi456\n')
      const m = await env.mirage("sed -nE '/[0-9]+/p'", data)
      const n = await env.native("sed -nE '/[0-9]+/p'", data)
      expect(m).toBe(n)
    } finally {
      await env.cleanup()
    }
  })

  it('sed anchored substitution matches native', async () => {
    // Regression for #326: ^/$ must anchor per line, not at buffer ends.
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('#123\nls\n')
      const m = await env.mirage("sed 's/^#[0-9]*$/#TS/'", data)
      const n = await env.native("sed 's/^#[0-9]*$/#TS/'", data)
      expect(m).toBe(n)
      expect(m).toBe('#TS\nls\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -E anchored substitution matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('#123\nls\n')
      const m = await env.mirage("sed -E 's/^#[0-9]+$/#TS/'", data)
      const n = await env.native("sed -E 's/^#[0-9]+$/#TS/'", data)
      expect(m).toBe(n)
      expect(m).toBe('#TS\nls\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed anchored address matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('12\nab\n34\n')
      const m = await env.mirage("sed '/^[0-9]*$/d'", data)
      const n = await env.native("sed '/^[0-9]*$/d'", data)
      expect(m).toBe(n)
      expect(m).toBe('ab\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed anchored substitution on a file argument matches native', async () => {
    // The single-`s` fast-path (file args) must anchor per line too (#326).
    const env = makeEnv(kind)
    try {
      env.createFile('anchors.txt', ENC.encode('#123\nls\n#456\nfoo bar\n'))
      const m = await env.mirage("sed 's/^#[0-9]*$/#TS/' /data/anchors.txt")
      const n = await env.native("sed 's/^#[0-9]*$/#TS/' anchors.txt")
      expect(m).toBe(n)
      expect(m).toBe('#TS\nls\n#TS\nfoo bar\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed non-global sub on a file replaces first match per line', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('multi.txt', ENC.encode('oo\noo\noo\n'))
      const m = await env.mirage("sed 's/o/O/' /data/multi.txt")
      const n = await env.native("sed 's/o/O/' multi.txt")
      expect(m).toBe(n)
      expect(m).toBe('Oo\nOo\nOo\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -i anchored substitution on a file matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('anchors_i.txt', ENC.encode('#123\nls\n#456\nfoo bar\n'))
      await env.mirage("sed -i 's/^#[0-9]*$/#TS/' /data/anchors_i.txt")
      const result = await env.mirage('cat /data/anchors_i.txt')
      expect(result).toBe('#TS\nls\n#TS\nfoo bar\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed s/// numeric count replaces Nth match, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('oooo\n')
      const m = await env.mirage("sed 's/o/O/2'", data)
      const n = await env.native("sed 's/o/O/2'", data)
      expect(m).toBe(n)
      expect(m).toBe('oOoo\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed s///p prints substituted line, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hi\nbye\n')
      const m = await env.mirage("sed 's/hi/HI/p'", data)
      const n = await env.native("sed 's/hi/HI/p'", data)
      expect(m).toBe(n)
      expect(m).toBe('HI\nHI\nbye\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -n s///p prints only substituted lines, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hi\nbye\n')
      const m = await env.mirage("sed -n 's/hi/HI/p'", data)
      const n = await env.native("sed -n 's/hi/HI/p'", data)
      expect(m).toBe(n)
      expect(m).toBe('HI\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed y/// transliterates, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello\n')
      const m = await env.mirage("sed 'y/el/ip/'", data)
      const n = await env.native("sed 'y/el/ip/'", data)
      expect(m).toBe(n)
      expect(m).toBe('hippo\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed c changes an addressed line, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage("sed '2c\\\nX'", data)
      const n = await env.native("sed '2c\\\nX'", data)
      expect(m).toBe(n)
      expect(m).toBe('a\nX\nc\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed c changes a line range once, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\nd\n')
      const m = await env.mirage("sed '2,3c\\\nX'", data)
      const n = await env.native("sed '2,3c\\\nX'", data)
      expect(m).toBe(n)
      expect(m).toBe('a\nX\nd\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed BRE group + backref matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo\n')
      const m = await env.mirage("sed 's/\\(foo\\)/[\\1]/'", data)
      const n = await env.native("sed 's/\\(foo\\)/[\\1]/'", data)
      expect(m).toBe(n)
      expect(m).toBe('[foo]\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed BRE interval and bare + literal match native', async () => {
    const env = makeEnv(kind)
    try {
      const d1 = ENC.encode('aaa\n')
      expect(await env.mirage("sed 's/a\\{2\\}/X/'", d1)).toBe(
        await env.native("sed 's/a\\{2\\}/X/'", d1),
      )
      const d2 = ENC.encode('a+b\n')
      const m = await env.mirage("sed 's/a+/X/'", d2)
      expect(m).toBe(await env.native("sed 's/a+/X/'", d2))
      expect(m).toBe('Xb\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -E group/quantifier/alternation match native', async () => {
    const env = makeEnv(kind)
    try {
      const d1 = ENC.encode('foo\n')
      expect(await env.mirage("sed -E 's/(foo)/[\\1]/'", d1)).toBe(
        await env.native("sed -E 's/(foo)/[\\1]/'", d1),
      )
      const d2 = ENC.encode('aaab\n')
      expect(await env.mirage("sed -E 's/a+/X/'", d2)).toBe(
        await env.native("sed -E 's/a+/X/'", d2),
      )
      const d3 = ENC.encode('dog\n')
      const m = await env.mirage("sed -E 's/cat|dog/PET/'", d3)
      expect(m).toBe(await env.native("sed -E 's/cat|dog/PET/'", d3))
      expect(m).toBe('PET\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -r is an alias for -E, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('aaab\n')
      const m = await env.mirage("sed -r 's/a+/X/'", data)
      const n = await env.native("sed -r 's/a+/X/'", data)
      expect(m).toBe(n)
      expect(m).toBe('Xb\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed multiple -e expressions apply in sequence, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\n')
      const m = await env.mirage("sed -e 's/a/b/' -e 's/b/c/'", data)
      const n = await env.native("sed -e 's/a/b/' -e 's/b/c/'", data)
      expect(m).toBe(n)
      expect(m).toBe('c\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -e with a file argument matches native', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('ef.txt', ENC.encode('hello world\n'))
      const m = await env.mirage('sed -e s/hello/bye/ /data/ef.txt')
      const n = await env.native('sed -e s/hello/bye/ ef.txt')
      expect(m).toBe(n)
      expect(m).toBe('bye world\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed negated line address matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage("sed '2!d'", data)
      const n = await env.native("sed '2!d'", data)
      expect(m).toBe(n)
      expect(m).toBe('b\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed negated regex address matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a\nb\nc\n')
      const m = await env.mirage("sed '/b/!d'", data)
      const n = await env.native("sed '/b/!d'", data)
      expect(m).toBe(n)
      expect(m).toBe('b\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed preserves a missing final newline, matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('foo')
      const m = await env.mirage("sed 's/o/O/'", data)
      const n = await env.native("sed 's/o/O/'", data)
      expect(m).toBe(n)
      expect(m).toBe('fOo')
    } finally {
      await env.cleanup()
    }
  })

  it('sed escaped delimiter matches native', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('a/b\n')
      const m = await env.mirage("sed 's/a\\/b/c/'", data)
      const n = await env.native("sed 's/a\\/b/c/'", data)
      expect(m).toBe(n)
      expect(m).toBe('c\n')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -i edits file in place', async () => {
    const env = makeEnv(kind)
    try {
      env.createFile('f.txt', ENC.encode('hello world\n'))
      await env.mirage('sed -i s/hello/bye/ /data/f.txt')
      const result = await env.mirage('cat /data/f.txt')
      expect(result).toContain('bye')
    } finally {
      await env.cleanup()
    }
  })

  it('sed -e applies expression', async () => {
    const env = makeEnv(kind)
    try {
      const data = ENC.encode('hello world\n')
      const result = await env.mirage('sed -e s/hello/bye/', data)
      expect(result).toContain('bye')
    } finally {
      await env.cleanup()
    }
  })
})

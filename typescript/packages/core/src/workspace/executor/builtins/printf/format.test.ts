import { describe, expect, it } from 'vitest'
import { encodeText } from '../../../../shell/bytes.ts'
import { YieldBudget } from '../../../../io/yield_budget.ts'
import { openStream } from '../../../../rs/stream.ts'
import { IOResult } from '../../../../io/types.ts'
import { printfOutput, runPrintf } from './format.ts'

const OCTAL_PINS: [string, string, string][] = [
  ['\\0003', '00 33', '03'],
  ['\\0', '00', '00'],
  ['\\00', '00', '00'],
  ['\\000', '00', '00'],
  ['\\0000', '00 30', '00'],
  ['\\08', '00 38', '00 38'],
  ['\\101', '41', '41'],
  ['\\1011', '41 31', '41 31'],
  ['\\0101', '08 31', '41'],
  ['\\400', '00', '00'],
  ['\\0400', '20 30', '00'],
]

const UNICODE_PINS: [string, string][] = [
  ['\\uD800', 'ed a0 80'],
  ['\\uDC80', 'ed b2 80'],
  ['\\uDFFF', 'ed bf bf'],
  ['\\uD83D\\uDE00', 'ed a0 bd ed b8 80'],
  ['\\U00110000', 'f4 90 80 80'],
  ['\\U0010FFFF', 'f4 8f bf bf'],
  ['\\U7FFFFFFF', 'fd bf bf bf bf bf'],
  ['\\U80000000', ''],
  ['\\UFFFFFFFF', ''],
  ['x\\UFFFFFFFFy', '78 79'],
  ['a\\u0000b', '61 00 62'],
  ['\\uDC80\\xff', 'ed b2 80 ff'],
]

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

describe('shared printf adapter', () => {
  it.each(OCTAL_PINS)('preserves the octal grammars for %s', async (escape, format, argument) => {
    const [out, err, status] = await runPrintf(escape, [])
    const [argOut, argErr, argStatus] = await runPrintf('%b', [escape])
    expect([hex(out), hex(argOut)]).toEqual([format, argument])
    expect([hex(err), status, hex(argErr), argStatus]).toEqual(['', 0, '', 0])
  })

  it.each(UNICODE_PINS)('preserves raw Unicode escape bytes for %s', async (escape, expected) => {
    for (const [fmt, args] of [
      [escape, []],
      ['%b', [escape]],
    ] satisfies [string, string[]][]) {
      const [out, err, status] = await runPrintf(fmt, args)
      expect([hex(out), hex(err), status]).toEqual([expected, '', 0])
    }
  })

  it.each([false, true])(
    'preserves signed special values and hex carry in program mode %s',
    async (program) => {
      const [out, err, status] = await runPrintf(
        '%+.1f|%+.1a|%.0a|%.1a|%.0f',
        ['nan', '-nan', '0x1.ffp0', '0x1.ffp0', '-0'],
        program,
      )
      expect([new TextDecoder().decode(out), hex(err), status]).toEqual([
        '+nan|-nan|0x2p+0|0x2.0p+0|-0',
        '',
        0,
      ])
    },
  )

  it('keeps diagnostics across argument stops and resets their failure status', async () => {
    const [out, err, status] = await runPrintf('%d%b%d', ['bad', 'x\\cy', 'unread'])
    expect([new TextDecoder().decode(out), new TextDecoder().decode(err), status]).toEqual([
      '0x',
      'bash: printf: bad: invalid number\n',
      0,
    ])
  })

  it('keeps failure on a format stop', async () => {
    const [out, err, status] = await runPrintf('%d\\c%d', ['bad', 'unread'])
    expect([new TextDecoder().decode(out), new TextDecoder().decode(err), status]).toEqual([
      '0',
      'bash: printf: bad: invalid number\n',
      1,
    ])
  })

  it('does not split surrogate pairs or lose raw bytes at host chunk boundaries', async () => {
    const raw = 'a'.repeat(4095) + '𐂀' + String.fromCharCode(0xdcff) + 'b'.repeat(17000)
    const [out, err, status] = await runPrintf('%s', [raw])
    expect(out).toEqual(encodeText(raw))
    expect([hex(err), status]).toEqual(['', 0])
  })

  it('cancels huge padding and precision and releases the Wasm handle', async () => {
    for (const fmt of ['%2147483647s', '%.2147483647f', '%.2147483647d']) {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, 30)
      try {
        await expect(
          runPrintf(fmt, ['1'], false, false, false, controller.signal),
        ).rejects.toThrow()
      } finally {
        clearTimeout(timer)
      }
    }
    const [out] = await runPrintf('%s', ['after'])
    expect(new TextDecoder().decode(out)).toBe('after')
  })

  it('brings a wide field out in bounded steps', async () => {
    const parts = printfOutput('%2147483647s', ['x'], new IOResult())
    const first = (await parts.next()).value as Uint8Array
    await parts.return(undefined)
    expect(first.every((byte) => byte === 0x20)).toBe(true)
    expect(first.byteLength).toBeGreaterThan(0)
    expect(first.byteLength).toBeLessThanOrEqual(16 * 1024)
  })
})

it('cancels a preloaded numeric scan before it finishes', async () => {
  const stream = await openStream('printf', { mode: 'builtin', argument_count: 1 })
  const raw = new Uint8Array(1024 * 1024 + 1).fill(48)
  raw[raw.length - 1] = 55
  stream.feedInput(0, encodeText('%d'))
  stream.endInput(0)
  for (let at = 0; at < raw.length; at += 16384) stream.feedInput(1, raw.subarray(at, at + 16384))
  stream.endInput(1)
  expect(stream.finish()).toHaveLength(0)
  const controller = new AbortController()
  const budget = new YieldBudget(controller.signal)
  try {
    const drain = async () => {
      while (stream.busy()) {
        stream.drain()
        await budget.run()
      }
    }
    const pending = drain()
    controller.abort(new Error('scan cancelled'))
    await expect(pending).rejects.toThrow('scan cancelled')
    expect(stream.busy()).toBe(true)
  } finally {
    stream.close()
  }
})

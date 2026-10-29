import type { JsonValue } from '@struktoai/mirage-core/types'
import cases from './composition.json'

const corpus = cases

interface CompositionStream {
  feed(data: Uint8Array): Uint8Array
  finish(): Uint8Array
  request(): [Record<string, JsonValue>, Uint8Array] | null
  respond(reply: Record<string, JsonValue>, data: Uint8Array): Uint8Array
}

function replyFields(value: Record<string, JsonValue | undefined>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
  )
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function equal(actual: unknown, expected: unknown, name: string): void {
  if (canonical(actual) !== canonical(expected))
    throw new Error(`${name}: expected ${canonical(expected)}, got ${canonical(actual)}`)
}

export function checkCompositionCorpus<T extends CompositionStream>(
  open: () => T,
  close: (stream: T) => void,
): number {
  for (const row of corpus.cases) {
    const stream = open()
    try {
      equal(stream.feed(encoder.encode(JSON.stringify(row.input))).byteLength, 0, row.name)
      equal(stream.finish().byteLength, 0, row.name)
      for (const [index, effect] of row.effects.entries()) {
        const request = stream.request()
        if (request === null) throw new Error(`${row.name}: missing effect ${String(index)}`)
        const [header, data] = request
        equal(
          header,
          { ...effect.request, evaluation: row.input.evaluation, effect: index + 1 },
          row.name,
        )
        equal(data.byteLength, 0, row.name)
        equal(stream.request(), null, row.name)
        equal(
          stream.respond(
            {
              ...replyFields(effect.reply),
              evaluation: header.evaluation ?? null,
              effect: header.effect ?? null,
            },
            new Uint8Array(),
          ).byteLength,
          0,
          row.name,
        )
      }
      equal(stream.request(), null, row.name)
      const output = stream.finish()
      equal(JSON.parse(decoder.decode(output)), row.expected, row.name)
    } finally {
      close(stream)
    }
  }
  return corpus.cases.length
}

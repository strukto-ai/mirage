import type { util } from 'zod'
import { isPlainObject } from '../utils/records.ts'
import { openStreamSync } from './stream.ts'

const decoder = new TextDecoder()

/** Text as the code points the stream reads, lone surrogates kept. Mirrors Python's units. */
export function units(value: string): number[] {
  return Array.from(value, (ch) => ch.codePointAt(0) ?? 0)
}

/** Code points from the stream back as text. Mirrors Python's from_units. */
export function fromUnits(value: readonly number[]): string {
  let out = ''
  for (let at = 0; at < value.length; at += 4096)
    out += String.fromCodePoint(...value.slice(at, at + 4096))
  return out
}

/** Encode a configuration document without losing lone surrogates or mapping order. */
function documentWire(value: unknown): util.JSONType {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return { text: units(value) }
  if (Array.isArray(value)) return { list: value.map(documentWire) }
  if (isPlainObject(value)) {
    return {
      map: Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [documentWire(key), documentWire(item)]),
    }
  }
  return 'invalid'
}

function documentFrom(value: util.JSONType): unknown {
  if (value === 'null') return null
  const node = value as {
    text?: number[]
    list?: util.JSONType[]
    map?: [util.JSONType, util.JSONType][]
  }
  if (node.text !== undefined) return fromUnits(node.text)
  if (node.list !== undefined) return node.list.map(documentFrom)
  if (node.map !== undefined)
    return Object.fromEntries(
      node.map.map(([key, item]) => [documentFrom(key), documentFrom(item)]),
    )
  throw new Error('invalid configuration document response')
}

/** Validate and normalize one field in the shared document engine. */
export function validateDocument(
  op: string,
  raw: unknown,
  where: string,
  options: { names?: string; root?: string; reason?: string } = {},
): unknown {
  const stream = openStreamSync('document', {
    op,
    raw: documentWire(raw),
    where_: units(where),
    dialect: 'ecmascript',
    ...(options.names === undefined ? {} : { names: options.names }),
    root: units(options.root ?? ''),
    reason: units(options.reason ?? ''),
  })
  try {
    const answer = JSON.parse(decoder.decode(stream.finish())) as {
      value: util.JSONType
      error?: string
    }
    if (answer.error !== undefined) throw new Error(answer.error)
    return documentFrom(answer.value)
  } finally {
    stream.close()
  }
}

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateDocument } from './document.ts'

const corpus = JSON.parse(
  readFileSync(new URL('../../../../../integ/policy/documents.json', import.meta.url), 'utf8'),
) as {
  cases: {
    id: string
    op: string
    value: unknown
    where: string
    options?: Parameters<typeof validateDocument>[3]
    error?: string
    expect?: unknown
  }[]
}

describe('shared document corpus', () => {
  for (const entry of corpus.cases) {
    it(entry.id, () => {
      const run = () => validateDocument(entry.op, entry.value, entry.where, entry.options)
      if (entry.error !== undefined) expect(run).toThrow(entry.error)
      else expect(run()).toEqual(entry.expect)
    })
  }
})

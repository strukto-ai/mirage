import { expect, it } from 'vitest'
import { functionSources } from './functions.ts'

it.each([null, [], { f: [] }, { f: 1 }])('refuses non-source function records: %j', (value) => {
  expect(() => functionSources(value)).toThrow('shell source strings')
})

import { expect, it } from 'vitest'
import { intOption } from './search.ts'

it.each([true, '10', null, 1.5])('rejects non-integer limit %j', (value) => {
  expect(() => intOption({ query: 'query', options: { top_k: value } }, 'top_k', 10)).toThrow(
    'integer',
  )
})

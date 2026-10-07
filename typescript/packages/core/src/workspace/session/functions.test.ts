import { assert, expect, it } from 'vitest'
import { getFunctionBody } from '../../shell/helpers.ts'
import type { ParsedProgram } from '../../shell/parse/program.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { functionTable, releaseFunctions } from './functions.ts'

async function defined(source: string): Promise<[ParsedProgram, TSNodeLike[]]> {
  const program = (await getTestParser()).parseProgram(source)
  const definition = program.root.namedChildren[0]
  assert(definition)
  const body = getFunctionBody(definition)
  assert(body)
  return [program, body]
}

it('leases a stored body once per name', async () => {
  const [program, body] = await defined('f() { echo a; echo b; }')
  const functions = functionTable({ f: body })
  expect(program.references).toBe(2)
  functions.g = body
  expect(program.references).toBe(3)
  releaseFunctions(functions)
  expect(program.references).toBe(1)
  expect(Object.keys(functions)).toEqual([])
})

it('releases the lease of a replaced or deleted name', async () => {
  const [first, old] = await defined('f() { echo old; }')
  const [second, fresh] = await defined('f() { echo new; }')
  const functions = functionTable({ f: old })
  functions.f = fresh
  expect([first.references, second.references]).toEqual([1, 2])
  delete functions.f
  expect(second.references).toBe(1)
  expect('f' in functions).toBe(false)
})

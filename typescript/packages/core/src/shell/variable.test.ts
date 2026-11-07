import { describe, expect, it } from 'vitest'
import {
  attrLetters,
  makeVar,
  VarAttr,
  varKind,
  VarKind,
  withValue,
  type ManagedRef,
} from './variable.ts'
import { makeArray } from './array.ts'

describe('attrLetters matches bash 5.2.37 declare -p order', () => {
  const cases: [string, ReturnType<typeof makeVar>][] = [
    ['irx', makeVar('1', new Set([VarAttr.Export, VarAttr.Readonly, VarAttr.Integer]))],
    ['Aiu', makeVar({}, new Set([VarAttr.Integer, VarAttr.Upper]))],
    ['arx', makeVar(makeArray([]), new Set([VarAttr.Readonly, VarAttr.Export]))],
    ['nrx', makeVar('a', new Set([VarAttr.Nameref, VarAttr.Readonly, VarAttr.Export]))],
    ['xl', makeVar('z', new Set([VarAttr.Export, VarAttr.Lower]))],
    ['', makeVar('5')],
  ]
  for (const [want, v] of cases) {
    it(`prints ${want || '(none)'}`, () => {
      expect(attrLetters(v)).toBe(want)
    })
  }
  it('derives kind from the value', () => {
    expect(varKind(makeVar('x'))).toBe(VarKind.Scalar)
    expect(varKind(makeVar(makeArray([])))).toBe(VarKind.Indexed)
    expect(varKind(makeVar({}))).toBe(VarKind.Assoc)
    expect(varKind(makeVar(null))).toBe(VarKind.Scalar)
  })
})

describe('managed variables', () => {
  const ref: ManagedRef = { source: 'aws-sm', ref: 'prod/agent', key: 'TOKEN', eager: false }

  it('managed defaults to absent', () => {
    expect(makeVar('x').managed).toBeUndefined()
  })

  it('withValue keeps the pointer', () => {
    // The fill step's write: fetching a value must not drop the pointer,
    // or a second fill pass could not tell a filled var from a plain one.
    const v = { value: null, attrs: new Set([VarAttr.Export]), managed: ref }
    expect(withValue(v, 'tok').managed).toBe(ref)
  })
})

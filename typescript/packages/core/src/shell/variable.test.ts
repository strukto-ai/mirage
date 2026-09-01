import { describe, expect, it } from 'vitest'
import {
  attrLetters,
  detach,
  makeVar,
  VarAttr,
  varKind,
  VarKind,
  withAttr,
  withValue,
  type ManagedRef,
} from './variable.ts'

describe('attrLetters matches bash 5.2.37 declare -p order', () => {
  const cases: [string, ReturnType<typeof makeVar>][] = [
    ['irx', makeVar('1', new Set([VarAttr.Export, VarAttr.Readonly, VarAttr.Integer]))],
    ['Aiu', makeVar({}, new Set([VarAttr.Integer, VarAttr.Upper]))],
    ['arx', makeVar([], new Set([VarAttr.Readonly, VarAttr.Export]))],
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
    expect(varKind(makeVar([]))).toBe(VarKind.Indexed)
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

  it('withAttr keeps the pointer', () => {
    const v = { value: null, attrs: new Set([VarAttr.Export]), managed: ref }
    expect(withAttr(v, VarAttr.Readonly).managed).toBe(ref)
  })

  it('detach drops the pointer and keeps value and attrs', () => {
    const v = { value: 'tok', attrs: new Set([VarAttr.Export]), managed: ref }
    const detached = detach(v)
    expect(detached.managed).toBeUndefined()
    expect(detached.value).toBe('tok')
    expect(detached.attrs).toBe(v.attrs)
  })
})

import { describe, expect, it } from 'vitest'
import { parseYaml } from './yaml.ts'

describe('parseYaml', () => {
  it.each([
    ['1e3', 1000],
    ['1E+3', 1000],
    ['1.0e3', 1000],
    ['1.e3', 1000],
    ['+.1e4', 1000],
    ['10000e-1', 1000],
    ['1e-3', 0.001],
    ['-1e3', -1000],
  ])('parses %s as a number', (source, expected) => {
    expect(parseYaml(`ttl: ${source}`)).toEqual({ ttl: expected })
  })

  it('preserves explicit strings', () => {
    expect(parseYaml(`values: ['1e3', "1e3", !!str 1e3]`)).toEqual({
      values: ['1e3', '1e3', '1e3'],
    })
  })

  it('preserves JSON numbers', () => {
    expect(parseYaml('{"ttl": 1e3, "enabled": true, "optional": null}')).toEqual({
      ttl: 1000,
      enabled: true,
      optional: null,
    })
  })
})

import type { Occurrence } from '../../policy/types.ts'
import type { TSNodeLike } from '../../shell/types.ts'

/** Copy portable function definitions without parsing or executing them. */
export function functionSources(value: unknown = {}): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('functions must map names to shell source strings')
  }
  const result = Object.create(null) as Record<string, string>
  for (const [name, source] of Object.entries(value)) {
    if (typeof source !== 'string') {
      throw new TypeError('functions must map names to shell source strings')
    }
    result[name] = source
  }
  return result
}

/**
 * Where a function was defined, for the source it was defined as. The
 * body is parsed again from that source at every call, so its own rows
 * and offsets start at zero; the site puts them back where the
 * definition stood. A site whose source no longer matches the table (a
 * checkout, a stored session) is not the function's. `mark` is the parse
 * and row the body reads aliases at; `origin` the definition's place on
 * its line, which the body's approvals stand under, null outside a line;
 * `aliases` the aliases the body runs, as its definition saw them
 * (`aliasView`), absent or null to read them as they are when it runs;
 * `name` what the body's diagnostics name as their source, the file it was
 * sourced from, absent for `environment`; `row` the row the definition starts
 * on as its text was typed, which the body's `$LINENO` counts from, absent
 * for 0; `lines`, for a definition inside a body bash prints again (`$( )`),
 * the line each node of the body is numbered by and ends on, in order, from
 * the definition's own (`siteLines`), absent for the rows as typed. Mirrors
 * Python's FunctionSite.
 */
export interface FunctionSite {
  readonly source: string
  readonly mark: readonly [number, number]
  readonly origin: Occurrence | null
  readonly aliases?: Readonly<Record<string, string>> | null
  readonly name?: string
  readonly row?: number
  readonly lines?: readonly (readonly [number, number] | null)[] | null
}

/** A body's nodes, each before its children, in order. */
function preorder(body: readonly TSNodeLike[]): TSNodeLike[] {
  const out: TSNodeLike[] = []
  const stack = [...body].reverse()
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    out.push(node)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]
      if (child !== undefined) stack.push(child)
    }
  }
  return out
}

/**
 * The lines a definition's body is numbered by in a body bash prints again,
 * each from `base`, the definition's own: a call parses the body again from
 * its text, whose rows bash does not count there (`f(){ echo $LINENO; }` in
 * `$( )` prints over several lines). Null outside such a body. Mirrors
 * Python's site_lines.
 */
export function siteLines(
  rows: ReadonlyMap<number, readonly [number, number]> | null,
  base: number,
  body: readonly TSNodeLike[],
): (readonly [number, number] | null)[] | null {
  if (rows === null) return null
  return preorder(body).map((node) => {
    const found = node.id === undefined ? undefined : rows.get(node.id)
    return found === undefined ? null : [found[0] - base, found[1] - base]
  })
}

/**
 * `siteLines` laid over a call's own parse of the body, by node id; null when
 * there are none, or the call's parse is shaped otherwise (an alias the body
 * expands now). Mirrors Python's called_lines.
 */
export function calledLines(
  lines: readonly (readonly [number, number] | null)[] | null | undefined,
  body: readonly TSNodeLike[],
): Map<number, readonly [number, number]> | null {
  const nodes = preorder(body)
  if (nodes.length !== lines?.length) return null
  const out = new Map<number, readonly [number, number]>()
  nodes.forEach((node, i) => {
    const line = lines[i]
    if (line !== null && line !== undefined && node.id !== undefined) out.set(node.id, line)
  })
  return out
}

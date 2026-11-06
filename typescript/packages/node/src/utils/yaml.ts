import { Document, parse, visit } from 'yaml'

/** YAML 1.2's `0o` octal, which YAML 1.1 quoting leaves bare and TypeScript reads as a number. */
const OCTAL = /^0o[0-7]+$/

/** Parse config scalars identically for validation and CLI transport. */
export function parseYaml(text: string): unknown {
  return parse(text)
}

/**
 * Write YAML that `parseYaml` and Python's loader both read back as `obj`:
 * YAML 1.1 quoting, so `off`, `yes` and `1e3` stay strings, and `0o` octal
 * quoted too.
 */
export function dumpYaml(obj: unknown): string {
  const doc = new Document(obj, { version: '1.1' })
  visit(doc, {
    Scalar(_, node) {
      if (typeof node.value === 'string' && OCTAL.test(node.value)) node.type = 'QUOTE_DOUBLE'
    },
  })
  return doc.toString()
}

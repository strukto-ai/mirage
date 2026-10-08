import { parse } from 'yaml'

/** Parse config scalars identically for validation and CLI transport. */
export function parseYaml(text: string): unknown {
  return parse(text)
}

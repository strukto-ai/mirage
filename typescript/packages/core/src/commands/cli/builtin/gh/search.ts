import {
  SEARCH_BOOLEAN,
  SEARCH_FLAGS,
  SEARCH_KIND_USAGE,
  SEARCH_MULTIPLE,
  SEARCH_QUERY_USE,
  SEARCH_SORTS,
  SEARCH_USAGE,
} from './constants.ts'
import { runLeaf } from './host.ts'
import { CLIHandler } from '../../types.ts'
import { Argument, CommandSpec } from '../../../spec/types.ts'

function usage(kind: string, name: string): readonly [string, string | null] {
  return SEARCH_KIND_USAGE[kind]?.[name] ?? SEARCH_USAGE[name] ?? ['', null]
}

function option(kind: string, name: string): Argument {
  const [help, metavar] = usage(kind, name)
  const choices: Record<string, string[]> = {
    state: ['open', 'closed'],
    'include-forks': ['false', 'true', 'only'],
    checks: ['pending', 'success', 'failure'],
    review: ['none', 'required', 'approved', 'changes_requested'],
  }
  const shorts: Record<string, string> = { repo: '-R', base: '-B', head: '-H' }
  return new Argument([...(shorts[name] === undefined ? [] : [shorts[name]]), `--${name}`], {
    action: SEARCH_MULTIPLE.includes(name) ? 'append' : 'store',
    nargs: SEARCH_BOOLEAN.includes(name) ? '?' : null,
    attachedOnly: SEARCH_BOOLEAN.includes(name),
    choices: SEARCH_BOOLEAN.includes(name) ? ['true', 'false'] : (choices[name] ?? []),
    metavar,
    help,
  })
}

export function searchSpec(): CommandSpec {
  return new CommandSpec({
    name: 'search',
    description: 'Search GitHub',
    subcommands: Object.entries(SEARCH_FLAGS).map(
      ([kind, names]) =>
        new CommandSpec({
          name: kind,
          description: `Search for ${kind}`,
          arguments: [
            ...names.map((name) => option(kind, name)),
            new Argument('--json', {
              metavar: usage(kind, 'json')[1],
              help: usage(kind, 'json')[0],
            }),
            new Argument(['-q', '--jq'], {
              metavar: usage(kind, 'jq')[1],
              help: usage(kind, 'jq')[0],
            }),
            new Argument(['-t', '--template'], { help: usage(kind, 'template')[0] }),
            new Argument(['-L', '--limit'], {
              type: 'int',
              default: '30',
              help: usage(kind, 'limit')[0],
            }),
            ...(SEARCH_SORTS[kind] === undefined
              ? []
              : [
                  new Argument('--sort', {
                    choices: SEARCH_SORTS[kind],
                    help: usage(kind, 'sort')[0],
                  }),
                  new Argument('--order', {
                    choices: ['asc', 'desc'],
                    help: usage(kind, 'order')[0],
                  }),
                ]),
            new Argument('QUERY', { nargs: '*', metavar: SEARCH_QUERY_USE[kind] ?? '[<query>]' }),
          ],
        }),
    ),
  })
}

export function searchHandlers(): Record<string, CLIHandler> {
  return Object.fromEntries(
    Object.keys(SEARCH_FLAGS).map((kind) => [
      `search ${kind}`,
      new CLIHandler({
        fn: (accessor, paths, texts, ctx) => runLeaf(`search ${kind}`, accessor, paths, texts, ctx),
      }),
    ]),
  )
}

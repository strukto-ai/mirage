import { expect, it } from 'vitest'
import { GIT } from './index.ts'
import { decorationStyle, parseFlags } from './history.ts'
import { Decoration } from './types.ts'
import { parseCommand, parseToKwargs } from '../../../spec/parser.ts'
import { FlagView } from '../../../spec/flag_view.ts'

it.each([
  [['--date-order', '--topo-order'], 'topo'],
  [['--topo-order', '--date-order'], 'date'],
  [['--topo-order', '--date-order', '--topo-order'], 'topo'],
  [['--graph', '--date-order', '--topo-order'], 'topo'],
  [['--date-order', '--graph'], 'date'],
  [['-S', '--topo-order', '--date-order'], 'date'],
])('honors the last ordering option in %j', (argv, expected) => {
  const spec = GIT.subcommands.find((node) => node.name === 'log')
  if (spec === undefined) throw new Error('missing log spec')
  const parsed = parseCommand(spec, argv, '/')
  expect(parseFlags(new FlagView(parseToKwargs(parsed))).order).toBe(expected)
})

function logFlags(argv: string[]): ReturnType<typeof parseFlags> {
  const spec = GIT.subcommands.find((node) => node.name === 'log')
  if (spec === undefined) throw new Error('missing log spec')
  return parseFlags(new FlagView(parseToKwargs(parseCommand(spec, argv, '/'))))
}

it.each([[['--max-count=2']], [['--max-count', '2']], [['-n', '2']], [['-n2']], [['-2']]])(
  'reads every spelling of the count in %j',
  (argv) => {
    expect(logFlags(argv).maxCount).toBe(2)
  },
)

it.each([
  [['-n', '3', '--max-count=1'], 1],
  [['--max-count=1', '-n', '3'], 3],
  [['-3', '--max-count=1'], 1],
  [['--max-count=-1'], null],
  [['-n', '-5'], null],
  [['--max-count=0'], 0],
])('takes the last count, a negative one as no limit, in %j', (argv, expected) => {
  expect(logFlags(argv).maxCount).toBe(expected)
})

it('keeps every --grep in both spellings', () => {
  const flags = logFlags(['--grep=fix', '--grep', 'typo'])
  expect(flags.greps.map((pattern) => pattern.test('a typo'))).toEqual([false, true])
  expect(flags.ignoreCase).toBe(false)
})

it.each([[['-i']], [['--regexp-ignore-case']]])(
  'folds case for --grep, --author and -S under %j',
  (argv) => {
    const flags = logFlags(['--grep=FIX', '--author=BOB', ...argv])
    expect(flags.ignoreCase).toBe(true)
    expect(flags.greps[0]?.test('fix: flag')).toBe(true)
    expect(flags.authors[0]?.test('Bob <bob@example.com>')).toBe(true)
  },
)

it.each([
  [['-E', '--grep=first|third'], 'third', true],
  [['-E', '-F', '--grep=first|third'], 'third', false],
  [['-F', '-E', '--grep=first|third'], 'third', true],
  [['--basic-regexp', '--grep=first|third'], 'third', false],
  [['-P', '--grep=^\\p{Ll}hird$'], 'third', true],
  [['-P', '--grep=[\\d]'], 'second', false],
  [['-P', '--grep=[[:alpha:]]irst'], 'first', true],
  [['-P', '--grep=f(?=irst)'], 'first', true],
  [['-P', '-i', '--grep=^THIRD$'], 'third', true],
  [['-P', '--grep=(?i)^THIRD$'], 'third', true],
  [['-P', '--grep=\\Athird\\z'], 'third', true],
  [['-P', '--grep=a\\-b\\_c\\ d'], 'a-b_c d', true],
  [['-P', '--grep=[]x]'], ']', true],
  [['-P', '--grep=a{x}'], 'a{x}', true],
])('reads every pattern with the last syntax in %j', (argv, line, expected) => {
  expect(logFlags(argv).greps[0]?.test(line)).toBe(expected)
})

it.each([
  [['--grep=\\('], "command line, '\\(': Unmatched ( or \\("],
  [['--author=\\('], "header, '\\(': Unmatched ( or \\("],
  [['--committer=\\('], "header, '\\(': Unmatched ( or \\("],
])('names where a refused pattern came from in %j', (argv, message) => {
  expect(() => logFlags(argv)).toThrow(message)
})

it.each([
  ['short', Decoration.SHORT],
  ['full', Decoration.FULL],
  ['no', Decoration.NONE],
  ['', Decoration.NONE],
  ['1', Decoration.SHORT],
  ['auto', Decoration.NONE],
  ['bogus', null],
  ['Full', null],
])('decorationStyle names git styles: %s', (value, style) => {
  expect(decorationStyle(value)).toBe(style)
})

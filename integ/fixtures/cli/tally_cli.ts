import {
  CLI,
  CLIHandler,
  CommandSpec,
  IOResult,
  Argument,
  z,
  type CommandFnResult,
  type Context,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NOOPAccessor } from '@struktoai/mirage-core/accessor/base'

const TallyConfig = z.object({ unit: z.string() })

type TallyConfigShape = { unit: string }

function total(
  accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): CommandFnResult {
  const sum: number = texts.reduce((acc: number, text: string) => acc + Number(text), 0)
  const line = `total ${sum} ${(accessor.config as TallyConfigShape).unit}\n`
  return [new TextEncoder().encode(line), new IOResult()]
}

export const TALLY = new CLI({
  spec: new CommandSpec({
    name: 'tally',
    description: 'Add numbers in a unit',
    subcommands: [
      new CommandSpec({
        name: 'sum',
        description: 'Sum the operands',
        arguments: [new Argument('values', { nargs: '*', metavar: '' })],
      }),
    ],
  }),
  handlers: { sum: new CLIHandler({ fn: total }) },
  configModel: TallyConfig,
})

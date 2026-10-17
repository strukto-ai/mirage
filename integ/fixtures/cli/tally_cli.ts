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

const TallyConfig = z.object({ unit: z.string() })

type TallyConfigShape = { unit: string }

function total(
  config: unknown,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): CommandFnResult {
  const sum: number = texts.reduce((acc: number, text: string) => acc + Number(text), 0)
  const line = `total ${sum} ${(config as TallyConfigShape).unit}\n`
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

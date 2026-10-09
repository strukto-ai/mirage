import {
  CLI,
  CLIHandler,
  CommandSpec,
  IOResult,
  Argument,
  z,
  type CLIInvocation,
  type CommandFnResult,
} from '@struktoai/mirage-core'

const TallyConfig = z.object({ unit: z.string() })

type TallyConfigShape = { unit: string }

function total(inv: CLIInvocation): CommandFnResult {
  const sum: number = inv.texts.reduce((acc: number, text: string) => acc + Number(text), 0)
  const line = `total ${sum} ${(inv.config as TallyConfigShape).unit}\n`
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

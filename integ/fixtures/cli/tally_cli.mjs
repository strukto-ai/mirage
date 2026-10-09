import { CLI, CLIHandler, CommandSpec, IOResult, Argument, z } from '@struktoai/mirage-core'

const TallyConfig = z.object({ unit: z.string() })

function total(inv) {
  const sum = inv.texts.reduce((acc, text) => acc + Number(text), 0)
  const line = `total ${sum} ${inv.config.unit}\n`
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

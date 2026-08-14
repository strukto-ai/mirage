import { CLISpec, IOResult, Operand, z } from '@struktoai/mirage-core'

const TallyConfig = z.object({ unit: z.string() })

function total(inv) {
  const sum = inv.texts.reduce((acc, text) => acc + Number(text), 0)
  const line = `total ${sum} ${inv.config.unit}\n`
  return [new TextEncoder().encode(line), new IOResult()]
}

export const TALLY = new CLISpec({
  name: 'tally',
  description: 'Add numbers in a unit',
  configModel: TallyConfig,
  subcommands: [
    new CLISpec({
      name: 'sum',
      description: 'Sum the operands',
      fn: total,
      rest: new Operand({ type: 'str' }),
    }),
  ],
})

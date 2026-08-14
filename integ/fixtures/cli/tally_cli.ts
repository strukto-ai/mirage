import {
  CLISpec,
  IOResult,
  Operand,
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

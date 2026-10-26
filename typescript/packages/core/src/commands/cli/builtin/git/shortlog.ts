import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { loadMailmap, mappedIdentity } from './mailmap.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { ShortlogOptionError } from './errors.ts'
import { subject } from './format.ts'
import { parseFlags, refCommits, select, walkEnds, walkOperands } from './history.ts'
import { opened } from './session.ts'
import { optionOperand, verbUsage } from './util.ts'

/** Summarize repository history by author. */
export async function shortlog(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  const word = optionOperand(ctx, texts)
  if (word !== null) throw new ShortlogOptionError(word, verbUsage(ctx))
  const repo = await opened(ctx, fl)
  const mailmap = await loadMailmap(repo.vfs, repo.location)
  const [revisions, pathspecs, dashed] = await walkOperands(ctx, fl, repo, texts)
  const flags = { ...parseFlags(fl, null, ctx.signal), pathspecs }
  const [starts, hidden] = await walkEnds(
    repo,
    revisions.length ? revisions : flags.allRefs ? [] : ['HEAD'],
    dashed,
  )
  if (flags.allRefs) for (const item of await refCommits(repo)) starts.push(item)
  const groups = new Map<string, string[]>()
  for (const commit of (await select(repo, starts, flags, hidden)).reverse()) {
    const identity = mappedIdentity(`${commit.authorName} <${commit.authorEmail}>`, mailmap)
    const name = fl.asBool('email') ? identity : identity.slice(0, identity.lastIndexOf(' <'))
    const messages = groups.get(name) ?? []
    messages.push(subject(commit))
    groups.set(name, messages)
  }
  const entries = [...groups].sort(
    ([a, x], [b, y]) =>
      (fl.asBool('numbered') ? y.length - x.length : 0) || compareCodePoints(a, b),
  )
  const text = entries
    .map(([name, messages]) =>
      fl.asBool('summary')
        ? `${String(messages.length).padStart(6)}\t${name}\n`
        : `${name} (${String(messages.length)}):\n` +
          messages.map((message) => `      ${message}\n`).join('') +
          '\n',
    )
    .join('')
  return [new TextEncoder().encode(text), new IOResult()]
}

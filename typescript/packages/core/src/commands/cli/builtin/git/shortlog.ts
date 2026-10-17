import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { loadMailmap, mappedIdentity } from './mailmap.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { GitError, ShortlogOptionError } from './errors.ts'
import { subject } from './format.ts'
import { parseFlags, refCommits, select } from './history.ts'
import { opened } from './session.ts'
import { splitRevisions } from './revparse.ts'
import { fatal, optionOperand, verbUsage } from './util.ts'

/** Summarize repository history by author. */
export async function shortlog(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  try {
    const word = optionOperand(ctx, texts)
    if (word !== null) throw new ShortlogOptionError(word, verbUsage(ctx))
    const repo = await opened(ctx, fl)
    const mailmap = await loadMailmap(repo.vfs, repo.location)
    const flags = parseFlags(fl)
    const [starts, hidden] = await splitRevisions(
      repo,
      texts.length ? texts : flags.allRefs ? [] : ['HEAD'],
    )
    if (flags.allRefs) starts.push(...(await refCommits(repo)))
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
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

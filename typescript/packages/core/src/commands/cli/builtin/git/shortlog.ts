import { loadMailmap, mappedIdentity } from './mailmap.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError, ShortlogOptionError } from './errors.ts'
import { subject } from './format.ts'
import { parseFlags, refCommits, select } from './history.ts'
import { opened } from './session.ts'
import { splitRevisions } from './revparse.ts'
import { fatal, optionOperand, verbUsage } from './util.ts'

/** Summarize repository history by author. */
export async function shortlog(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    const word = optionOperand(inv, inv.texts)
    if (word !== null) throw new ShortlogOptionError(word, verbUsage(inv))
    const repo = await opened(fl, inv.view ?? {})
    const mailmap = await loadMailmap(repo.dispatch, repo.location)
    const flags = parseFlags(fl)
    const [starts, hidden] = await splitRevisions(
      repo,
      inv.texts.length ? inv.texts : flags.allRefs ? [] : ['HEAD'],
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

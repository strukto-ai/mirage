import { Worker } from '../concurrency/worker.ts'
import { foldsAsciiOnly } from './posix.ts'
import { loopLimit } from './regex_cost.ts'
import { scan, type Match } from './regex_scan.ts'

/**
 * Matches found where each subject's worst case allows, rendered here. A
 * subject within the pattern's loopLimit is scanned in place: its search
 * cannot run past LOOP_BUDGET steps. Any other subject is its own call to the
 * worker, which only that starts, so a slow subject sent ahead never holds
 * back the answer for one before it, and a runaway search stays killable
 * (strukto-ai/mirage#1590).
 */
export class AsyncRegex extends RegExp {
  private readonly worker: Worker
  private readonly ownsWorker: boolean
  private readonly limit: number
  private readonly ascii: boolean
  private readonly cache = new Map<string, RegExpExecArray[]>()
  private readonly sent = new Map<string, Promise<Match[]>>()
  constructor(
    private readonly original: RegExp,
    private readonly signal?: AbortSignal,
    private readonly allMatches = true,
    worker?: Worker,
  ) {
    super(original.source, original.flags)
    this.ownsWorker = worker === undefined
    this.worker = worker ?? new Worker()
    this.limit = loopLimit(original)
    this.ascii = foldsAsciiOnly(original)
  }

  /**
   * Fetch `text`'s matches, sending the subjects buffered behind it that are
   * past the limit along.
   */
  async prepare(text: string, following?: () => string[]): Promise<void> {
    const cached = this.cache.get(text)
    if (cached !== undefined) {
      this.cache.delete(text)
      this.cache.set(text, cached)
      return
    }
    if (text.length <= this.limit) {
      this.signal?.throwIfAborted()
      const { source, flags } = this.original
      this.remember(text, scan(source, flags, this.ascii, text, this.allMatches))
    } else await this.fetch(text, following)
    while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value ?? '')
  }

  private async fetch(text: string, following?: () => string[]): Promise<void> {
    if (!this.sent.has(text))
      for (const subject of [text, ...(following?.() ?? [])])
        if (subject.length > this.limit && !this.cache.has(subject) && !this.sent.has(subject))
          this.sent.set(subject, this.scan(subject))
    // Answers come in order, so every subject sent before `text` has one too.
    for (const [subject, matches] of this.sent) {
      this.sent.delete(subject)
      this.remember(subject, await matches)
      if (subject === text) break
    }
  }

  private scan(subject: string): Promise<Match[]> {
    const { source, flags } = this.original
    const matches = this.worker.call<Match[]>(
      'scan',
      [source, flags, this.ascii, subject, this.allMatches],
      this.signal,
    )
    // prepare awaits it in order; one it never reaches is dropped unread.
    matches.catch(() => undefined)
    return matches
  }

  private remember(subject: string, found: Match[]): void {
    this.cache.set(
      subject,
      found.map((match) => {
        const native = match.values as RegExpExecArray
        native.index = match.index
        native.input = subject
        if (match.groups !== undefined) native.groups = match.groups
        if (match.indices !== undefined) native.indices = match.indices
        return native
      }),
    )
  }

  matches(text: string): RegExpExecArray[] {
    const matches = this.cache.get(text)
    if (matches === undefined) throw new Error('regex subject was not prepared')
    return matches
  }

  search(text: string, from = 0): RegExpExecArray | null {
    const matches = this.matches(text)
    let lo = 0,
      hi = matches.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((matches[mid]?.index ?? 0) < from) lo = mid + 1
      else hi = mid
    }
    return matches[lo] ?? null
  }

  override exec(text: string): RegExpExecArray | null {
    const match = this.search(text, this.global || this.sticky ? this.lastIndex : 0)
    if (this.global || this.sticky)
      this.lastIndex = match === null ? 0 : match.index + match[0].length
    return match
  }

  /** Answers still owed for a shared worker resolve unread. */
  async close(): Promise<void> {
    if (this.ownsWorker) await this.worker.close()
    this.sent.clear()
    this.cache.clear()
  }
}

export async function prepare(pattern: RegExp, text: string): Promise<void> {
  if (pattern instanceof AsyncRegex) await pattern.prepare(text)
}

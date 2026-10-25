import type { AdmissionRules, CommandRule, HideReason } from '../policy/types.ts'
import {
  MountMode,
  type HiddenPaths,
  type HiddenVars,
  type ShowEntry,
  type ShownPaths,
  type Visibility,
} from '../types.ts'
import { compiledModuleSync } from './stream.ts'
import type { LinkStep } from '../utils/path.ts'

const CACHE_LIMIT = 128
const MAX_UNITS = 16 * 1024 * 1024
const MAX_FACT_UNITS = Math.floor(0x7fffffff / Uint32Array.BYTES_PER_ELEMENT)
const CHUNK_UNITS = 1024 * 1024
const MODES = [MountMode.READ, MountMode.WRITE, MountMode.EXEC]

enum LinkState {
  Unfollowed = 0,
  Followed = 1,
  Hidden = 2,
  HopLimit = 3,
}

type PolicyCommands = Readonly<Partial<AdmissionRules>>
interface PolicyPaths {
  readonly hide: readonly string[]
  readonly show?: ShownPaths['entries']
  readonly reasons?: readonly HideReason[]
}
interface PolicyMount {
  readonly mode?: MountMode | null
  readonly commands?: Omit<PolicyCommands, 'allow'> | null
  readonly paths?: PolicyPaths | null
}
interface PolicyProfile {
  readonly commands?: PolicyCommands | null
  readonly paths?: PolicyPaths | null
  readonly vars?: { readonly hide: readonly string[] } | null
  readonly mounts?: ReadonlyMap<string, PolicyMount> | null
}
export interface PolicyPath {
  readonly virtual: string
  readonly display: string
}
export interface PolicyFacts {
  readonly command: string
  readonly tokens: readonly string[]
  readonly tool: boolean
  readonly cwd: string
  readonly paths: readonly PolicyPath[]
  readonly operands: readonly PolicyPath[]
  readonly walks: boolean
  readonly moveTarget: string | null
}
export interface PolicySubject {
  readonly path: PolicyPath | null
  readonly holds: boolean
  readonly ancestors: boolean
}
export interface PolicyRuling {
  readonly outcome: number
  readonly rule: number | null
  readonly matched: string | null
  readonly allowList: boolean
  readonly asks: readonly number[]
}
export interface PolicyPlan {
  readonly commands: AdmissionRules | null
  readonly visibility: Visibility
  readonly mountModes: Map<string, MountMode> | null
  readonly hideReasons: readonly HideReason[]
}

class Packet {
  readonly units: number[] = []
  hasFacts = false
  static textWords(value: string): number {
    let words = 1
    const units = value[Symbol.iterator]()
    while (!units.next().done) words += 1
    return words
  }
  static readonly linkStepPlan = (step: LinkStep): { step: LinkStep; words: number } => {
    let words: number
    switch (step.kind) {
      case 'follow':
      case 'landing':
        words = 1 + Packet.textWords(step.path)
        break
      case 'enter':
        words = 2 + Packet.textWords(step.path)
        break
      case 'hop_limit':
        words = 1
        break
      default: {
        const exhaustive: never = step
        throw new TypeError('Invalid policy link step', { cause: exhaustive })
      }
    }
    if (2 + words > MAX_UNITS) throw new Error('Policy packet is too large')
    return { step, words }
  }
  static readonly linkCandidatePlan = (value: readonly [string, readonly LinkStep[]]) => {
    const pathWords = Packet.textWords(value[0])
    if (pathWords > MAX_UNITS) throw new Error('Policy packet is too large')
    const trace = value[1].map(Packet.linkStepPlan)
    const words = pathWords + 1 + trace.reduce((total, part) => total + part.words, 0)
    return { value, trace, words }
  }
  number(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new RangeError('Policy packet integer is outside u32')
    this.units.push(value)
  }
  boolean(value: boolean): void {
    this.number(value ? 1 : 0)
  }
  text(value: string): void {
    const units = Array.from(value, (ch) => ch.codePointAt(0) ?? 0)
    this.number(units.length)
    for (const unit of units) this.units.push(unit)
  }
  list<T>(values: readonly T[], write: (packet: Packet, value: T) => void): void {
    this.number(values.length)
    for (const value of values) write(this, value)
  }
  optional<T>(value: T | null | undefined, write: (packet: Packet, value: T) => void): void {
    this.boolean(value != null)
    if (value != null) write(this, value)
  }
  mode(value: MountMode): void {
    this.number(MODES.indexOf(value))
  }
  rule(value: CommandRule): void {
    this.text(value.reason)
    this.list(value.commands ?? [], (p, t) => {
      p.text(t)
    })
    this.list(value.paths ?? [], (p, t) => {
      p.text(t)
    })
    this.optional(value.mount, (p, mount) => {
      p.text(mount)
    })
  }
  rules(value: PolicyCommands): void {
    this.optional(value.allow, (p, v) => {
      p.list(v, (p, t) => {
        p.text(t)
      })
    })
    this.list(value.deny ?? [], (p, r) => {
      p.rule(r)
    })
    this.list(value.ask ?? [], (p, r) => {
      p.rule(r)
    })
  }
  hidden(value: HiddenPaths | null | undefined): void {
    this.list(value?.paths ?? [], (p, t) => {
      p.text(t)
    })
    this.list(value?.patterns ?? [], (p, t) => {
      p.text(t)
    })
  }
  show(value: ShowEntry): void {
    this.text(value.path)
    this.optional(value.mode, (p, m) => {
      p.mode(m)
    })
  }
  reason(value: HideReason): void {
    this.list(value.patterns, (p, t) => {
      p.text(t)
    })
    this.text(value.reason)
  }
  visibility(value: Partial<Visibility>): void {
    this.hidden(value.paths)
    this.list(value.shown?.entries ?? [], (p, s) => {
      p.show(s)
    })
    this.list(value.vars?.names ?? [], (p, t) => {
      p.text(t)
    })
    this.list(value.vars?.patterns ?? [], (p, t) => {
      p.text(t)
    })
  }
  paths(value: PolicyPaths): void {
    this.list(value.hide, (p, t) => {
      p.text(t)
    })
    this.list(value.show ?? [], (p, s) => {
      p.show(s)
    })
    this.list(value.reasons ?? [], (p, r) => {
      p.reason(r)
    })
  }
  mount(value: readonly [string, PolicyMount]): void {
    this.text(value[0])
    this.optional(value[1].mode, (p, m) => {
      p.mode(m)
    })
    this.optional(value[1].commands, (p, c) => {
      p.rules(c)
    })
    this.optional(value[1].paths, (p, v) => {
      p.paths(v)
    })
  }
  profile(value: PolicyProfile): void {
    this.optional(value.commands, (p, v) => {
      p.rules(v)
    })
    this.optional(value.paths, (p, v) => {
      p.paths(v)
    })
    this.optional(value.vars?.hide, (p, v) => {
      p.list(v, (p, t) => {
        p.text(t)
      })
    })
    this.optional(value.mounts, (p, v) => {
      p.list([...v], (p, m) => {
        p.mount(m)
      })
    })
  }
  path(value: PolicyPath): void {
    this.text(value.virtual)
    this.text(value.display)
  }
  facts(value: PolicyFacts): void {
    this.hasFacts = true
    let words =
      this.units.length +
      9 +
      value.tokens.length +
      2 * value.paths.length +
      2 * value.operands.length +
      Number(value.moveTarget !== null)
    if (words > MAX_FACT_UNITS) throw new Error('Policy facts exceed addressable memory')
    const texts = new Map<string, number>()
    const ref = (text: string): number => {
      const existing = texts.get(text)
      if (existing !== undefined) return existing
      words += Packet.textWords(text)
      if (words > MAX_FACT_UNITS) throw new Error('Policy facts exceed addressable memory')
      const id = texts.size
      texts.set(text, id)
      return id
    }
    const command = ref(value.command)
    const tokens = value.tokens.map(ref)
    const cwd = ref(value.cwd)
    const paths = value.paths.map((path) => [ref(path.virtual), ref(path.display)] as const)
    const operands = value.operands.map((path) => [ref(path.virtual), ref(path.display)] as const)
    const moveTarget = value.moveTarget === null ? null : ref(value.moveTarget)
    this.list([...texts.keys()], (p, text) => {
      p.text(text)
    })
    this.number(command)
    this.list(tokens, (p, id) => {
      p.number(id)
    })
    this.boolean(value.tool)
    this.number(cwd)
    for (const entries of [paths, operands]) {
      this.list(entries, (p, path) => {
        p.number(path[0])
        p.number(path[1])
      })
    }
    this.boolean(value.walks)
    this.optional(moveTarget, (p, id) => {
      p.number(id)
    })
  }
  subject(value: PolicySubject): void {
    this.optional(value.path, (p, v) => {
      p.path(v)
    })
    this.boolean(value.holds)
    this.boolean(value.ancestors)
  }
  linkTrace(trace: readonly LinkStep[]): void {
    this.list(trace, (p, step) => {
      switch (step.kind) {
        case 'follow':
          p.number(0)
          p.text(step.path)
          break
        case 'enter':
          p.number(1)
          p.text(step.path)
          p.boolean(step.nextIsParent)
          break
        case 'landing':
          p.number(2)
          p.text(step.path)
          break
        case 'hop_limit':
          p.number(3)
          break
      }
    })
  }
}

class Reply {
  private offset = 0
  constructor(private readonly units: Uint32Array) {}
  number(): number {
    const value = this.units[this.offset++]
    if (value === undefined) throw new Error('Truncated policy reply')
    return value
  }
  boolean(): boolean {
    const value = this.number()
    if (value !== 0 && value !== 1) throw new Error('Invalid policy boolean reply')
    return value === 1
  }
  linkState(): LinkState {
    const state = this.number()
    switch (state) {
      case 0:
        return LinkState.Unfollowed
      case 1:
        return LinkState.Followed
      case 2:
        return LinkState.Hidden
      case 3:
        return LinkState.HopLimit
      default:
        throw new Error('Invalid policy link state reply')
    }
  }
  text(): string {
    const length = this.number()
    if (length > this.units.length - this.offset) throw new Error('Truncated policy text reply')
    let value = ''
    const end = this.offset + length
    while (this.offset < end) {
      const next = Math.min(end, this.offset + 4096)
      value += String.fromCodePoint(...this.units.subarray(this.offset, next))
      this.offset = next
    }
    return value
  }
  list<T>(read: (reply: Reply) => T): T[] {
    const length = this.number()
    if (length > this.units.length - this.offset) throw new Error('Invalid policy list reply')
    return Array.from({ length }, () => read(this))
  }
  optional<T>(read: (reply: Reply) => T): T | null {
    return this.boolean() ? read(this) : null
  }
  mode(): MountMode {
    const mode = MODES[this.number()]
    if (mode === undefined) throw new Error('Invalid policy mode reply')
    return mode
  }
  rule(): CommandRule {
    const reason = this.text(),
      commands = this.list((r) => r.text()),
      paths = this.list((r) => r.text()),
      mount = this.optional((r) => r.text())
    return {
      reason,
      ...(commands.length === 0 ? {} : { commands }),
      ...(paths.length === 0 ? {} : { paths }),
      ...(mount === null ? {} : { mount }),
    }
  }
  rules(): AdmissionRules {
    return {
      allow: this.optional((r) => r.list((r) => r.text())),
      deny: this.list((r) => r.rule()),
      ask: this.list((r) => r.rule()),
    }
  }
  hidden(): HiddenPaths | null {
    const paths = this.list((r) => r.text()),
      patterns = this.list((r) => r.text())
    return paths.length + patterns.length === 0 ? null : { paths, patterns }
  }
  show(): ShowEntry {
    return { path: this.text(), mode: this.optional((r) => r.mode()) }
  }
  reason(): HideReason {
    return { patterns: this.list((r) => r.text()), reason: this.text() }
  }
  visibility(): Visibility {
    const paths = this.hidden(),
      entries = this.list((r) => r.show()),
      names = this.list((r) => r.text()),
      patterns = this.list((r) => r.text())
    return {
      paths,
      shown: entries.length === 0 ? null : { entries },
      vars: names.length + patterns.length === 0 ? null : { names, patterns },
      processes: 'session',
    }
  }
  paths(): PolicyPaths {
    const hide = this.list((r) => r.text()),
      show = this.list((r) => r.show()),
      reasons = this.list((r) => r.reason())
    return {
      hide,
      ...(show.length === 0 ? {} : { show }),
      ...(reasons.length === 0 ? {} : { reasons }),
    }
  }
  mount(): readonly [string, PolicyMount] {
    const prefix = this.text(),
      mode = this.optional((r) => r.mode()),
      commands = this.optional((r) => r.rules()),
      paths = this.optional((r) => r.paths())
    return [
      prefix,
      {
        ...(mode === null ? {} : { mode }),
        ...(commands === null ? {} : { commands: { ask: commands.ask, deny: commands.deny } }),
        ...(paths === null ? {} : { paths }),
      },
    ]
  }
  profile(): PolicyProfile {
    return {
      commands: this.optional((r) => r.rules()),
      paths: this.optional((r) => r.paths()),
      vars: this.optional((r) => ({ hide: r.list((r) => r.text()) })),
      mounts: this.optional((r) => new Map(r.list((r) => r.mount()))),
    }
  }
  path(): PolicyPath {
    return { virtual: this.text(), display: this.text() }
  }
  subject(): PolicySubject {
    return {
      path: this.optional((r) => r.path()),
      holds: this.boolean(),
      ancestors: this.boolean(),
    }
  }
}

interface Instance {
  readonly memory: WebAssembly.Memory
  readonly input: (length: number) => number
  readonly call: (operation: number, handle: number) => number
  readonly factsChunk: (offset: number, total: number) => number
  readonly factsCall: (operation: number, handle: number) => number
  readonly factsClear: () => void
  readonly output: () => number
  readonly outputLength: () => number
  readonly error: () => number
  readonly errorLength: () => number
}
let current: Instance | undefined
let generation = 0
let queuedRetirement: Instance | undefined
const RECYCLE_BYTES = 32 * 1024 * 1024

function retireLater(native: Instance): void {
  if (
    current !== native ||
    native.memory.buffer.byteLength <= RECYCLE_BYTES ||
    queuedRetirement === native
  )
    return
  const opened = generation
  queuedRetirement = native
  queueMicrotask(() => {
    if (queuedRetirement === native) queuedRetirement = undefined
    if (current !== native || generation !== opened) return
    current = undefined
    generation += 1
    clearCaches(false)
  })
}

function exported(exports: WebAssembly.Exports, name: string): (...args: number[]) => number {
  const fn = exports[name]
  if (typeof fn !== 'function') throw new Error(`Missing policy export ${name}`)
  return fn as (...args: number[]) => number
}
function instance(): Instance {
  if (current !== undefined) return current
  const exports = new WebAssembly.Instance(compiledModuleSync(), {}).exports
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error('Missing policy Wasm memory')
  current = {
    memory: exports.memory,
    input: exported(exports, 'mirage_policy_input'),
    call: exported(exports, 'mirage_policy_call'),
    factsChunk: exported(exports, 'mirage_policy_facts_chunk'),
    factsCall: exported(exports, 'mirage_policy_facts_call'),
    factsClear: exported(exports, 'mirage_policy_facts_clear'),
    output: exported(exports, 'mirage_policy_output'),
    outputLength: exported(exports, 'mirage_policy_output_len'),
    error: exported(exports, 'mirage_policy_error'),
    errorLength: exported(exports, 'mirage_policy_error_len'),
  }
  generation += 1
  return current
}
function invoke(operation: number, handle: number, write?: (packet: Packet) => void): Reply {
  const packet = new Packet()
  write?.(packet)
  const staged = packet.hasFacts && packet.units.length > MAX_UNITS
  if (!staged && packet.units.length > MAX_UNITS) throw new Error('Policy packet is too large')
  const native = instance()
  const checked = (status: number): void => {
    if (status !== 0) {
      throw new Error(
        new TextDecoder().decode(
          new Uint8Array(native.memory.buffer, native.error(), native.errorLength()),
        ),
      )
    }
  }
  try {
    if (staged) {
      for (let offset = 0; offset < packet.units.length; offset += CHUNK_UNITS) {
        const length = Math.min(CHUNK_UNITS, packet.units.length - offset)
        const ptr = native.input(length)
        if (ptr === 0) throw new Error('Policy packet allocation failed')
        new Uint32Array(native.memory.buffer, ptr, length).set(
          packet.units.slice(offset, offset + length),
        )
        checked(native.factsChunk(offset, packet.units.length))
      }
      checked(native.factsCall(operation, handle))
    } else {
      const ptr = native.input(packet.units.length)
      if (ptr === 0 && packet.units.length !== 0) throw new Error('Policy packet allocation failed')
      new Uint32Array(native.memory.buffer, ptr, packet.units.length).set(packet.units)
      checked(native.call(operation, handle))
    }
    return new Reply(
      new Uint32Array(native.memory.buffer, native.output(), native.outputLength()).slice(),
    )
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      current = undefined
      generation += 1
      clearCaches(false)
    }
    throw error
  } finally {
    if (staged && current === native) native.factsClear()
    retireLater(native)
  }
}

abstract class Handle {
  private closed = false
  readonly generation: number
  protected constructor(private readonly handle: number) {
    this.generation = generation
  }
  get live(): boolean {
    return !this.closed && this.generation === generation
  }
  protected query(operation: number, write?: (packet: Packet) => void): Reply {
    this.requireLive()
    return invoke(operation, this.handle, write)
  }
  protected requireLive(): void {
    if (!this.live) throw new Error('Closed policy matcher')
  }
  close(drop = true): void {
    if (this.closed) return
    if (drop && this.generation === generation) invoke(60, this.handle)
    this.closed = true
  }
}

export class AdmissionMatcher extends Handle {
  constructor(rules: PolicyCommands) {
    super(
      invoke(1, 0, (p) => {
        p.rules(rules)
      }).number(),
    )
  }
  headAllowed(name: string): boolean {
    return this.query(20, (p) => {
      p.text(name)
    }).boolean()
  }
  lineAllowed(tokens: readonly string[], tool: boolean): boolean {
    return this.query(21, (p) => {
      p.list(tokens, (p, t) => {
        p.text(t)
      })
      p.boolean(tool)
    }).boolean()
  }
  hasRules(): boolean {
    return this.query(22).boolean()
  }
  readsArgs(name: string): boolean {
    return this.query(23, (p) => {
      p.text(name)
    }).boolean()
  }
  scopesPaths(name: string): boolean {
    return this.query(24, (p) => {
      p.text(name)
    }).boolean()
  }
  decide(facts: PolicyFacts): PolicyRuling {
    const reply = this.query(25, (p) => {
      p.facts(facts)
    })
    return {
      outcome: reply.number(),
      rule: reply.optional((r) => r.number()),
      matched: reply.optional((r) => r.text()),
      allowList: reply.boolean(),
      asks: reply.list((r) => r.number()),
    }
  }
  ioReach(tokens: readonly string[], path: string): boolean {
    return this.query(26, (p) => {
      p.list(tokens, (p, t) => {
        p.text(t)
      })
      p.text(path)
    }).boolean()
  }
  ioRefusal(tokens: readonly string[], path: string, grants: readonly number[]): number | null {
    return this.query(27, (p) => {
      p.list(tokens, (p, t) => {
        p.text(t)
      })
      p.text(path)
      p.list(grants, (p, n) => {
        p.number(n)
      })
    }).optional((r) => r.number())
  }
  opRuling(op: string, path: string, grants: readonly number[]): readonly [number, boolean] | null {
    return this.query(28, (p) => {
      p.text(op)
      p.text(path)
      p.list(grants, (p, n) => {
        p.number(n)
      })
    }).optional((r) => [r.number(), r.boolean()])
  }
  ruleApplies(id: number, facts: PolicyFacts): boolean {
    return this.query(29, (p) => {
      p.number(id)
      p.facts(facts)
    }).boolean()
  }
  ruleReach(id: number, subject: PolicySubject): number | null {
    return this.query(30, (p) => {
      p.number(id)
      p.subject(subject)
    }).optional((r) => r.number())
  }
  hiddenDepth(id: number, path: string): number {
    return this.query(31, (p) => {
      p.number(id)
      p.text(path)
    }).number()
  }
  coversDepth(id: number, path: string, ancestors: boolean): number {
    return this.query(32, (p) => {
      p.number(id)
      p.text(path)
      p.boolean(ancestors)
    }).number()
  }
  matchIo(id: number, tokens: readonly string[], path: string, subtree: boolean): boolean {
    return this.query(33, (p) => {
      p.number(id)
      p.list(tokens, (p, t) => {
        p.text(t)
      })
      p.text(path)
      p.boolean(subtree)
    }).boolean()
  }
  opReach(id: number, op: string, path: string): number | null {
    return this.query(34, (p) => {
      p.number(id)
      p.text(op)
      p.text(path)
    }).optional((r) => r.number())
  }
  posixLevel(id: number): boolean {
    return this.query(35, (p) => {
      p.number(id)
    }).boolean()
  }
}

export class VisibilityMatcher extends Handle {
  constructor(vis: Partial<Visibility>) {
    super(
      invoke(2, 0, (p) => {
        p.visibility(vis)
      }).number(),
    )
  }
  hideDepth(path: string): number | null {
    return this.query(40, (p) => {
      p.text(path)
    }).optional((r) => r.number())
  }
  showDepth(path: string): number | null {
    return this.query(41, (p) => {
      p.text(path)
    }).optional((r) => r.number())
  }
  pathVisible(path: string): boolean {
    return this.query(42, (p) => {
      p.text(path)
    }).boolean()
  }
  shownMode(path: string): readonly [number, MountMode] | null {
    return this.query(43, (p) => {
      p.text(path)
    }).optional((r) => [r.number(), r.mode()])
  }
  pathCovers(path: string, ancestors: boolean): boolean {
    return this.query(44, (p) => {
      p.text(path)
      p.boolean(ancestors)
    }).boolean()
  }
  hidesIntersect(path: string): boolean {
    return this.query(45, (p) => {
      p.text(path)
    }).boolean()
  }
  moveReveals(src: string, dst: string): boolean {
    return this.query(46, (p) => {
      p.text(src)
      p.text(dst)
    }).boolean()
  }
  linkTraceHidden(trace: readonly LinkStep[]): boolean {
    this.requireLive()
    return this.traceHidden(trace.map(Packet.linkStepPlan))
  }
  private traceHidden(trace: readonly ReturnType<typeof Packet.linkStepPlan>[]): boolean {
    let state = LinkState.Unfollowed
    let chunk: LinkStep[] = []
    let words = 2
    const flush = (current: LinkState): LinkState => {
      const next = this.query(47, (p) => {
        p.number(current)
        p.linkTrace(chunk)
      }).linkState()
      chunk = []
      words = 2
      return next
    }
    for (const part of trace) {
      if (chunk.length > 0 && words + part.words > CHUNK_UNITS) {
        state = flush(state)
        if (state === LinkState.Hidden || state === LinkState.HopLimit)
          return state === LinkState.Hidden
      }
      chunk.push(part.step)
      words += part.words
    }
    if (chunk.length > 0) state = flush(state)
    return state === LinkState.Hidden
  }
  visibleLinks(candidates: readonly (readonly [string, readonly LinkStep[]])[]): boolean[] {
    this.requireLive()
    const plans = candidates.map(Packet.linkCandidatePlan)
    const result: boolean[] = []
    let chunk: (typeof candidates)[number][] = []
    let words = 1
    const flush = (): void => {
      if (chunk.length === 0) return
      const mask = this.query(52, (p) => {
        p.list(chunk, (p, [path, trace]) => {
          p.text(path)
          p.linkTrace(trace)
        })
      }).list((r) => r.boolean())
      for (const visible of mask) result.push(visible)
      chunk = []
      words = 1
    }
    for (const plan of plans) {
      if (1 + plan.words > MAX_UNITS) {
        flush()
        result.push(this.pathVisible(plan.value[0]) && !this.traceHidden(plan.trace))
        continue
      }
      if (chunk.length > 0 && words + plan.words > CHUNK_UNITS) flush()
      chunk.push(plan.value)
      words += plan.words
    }
    flush()
    return result
  }
  varHidden(name: string): boolean {
    return this.query(48, (p) => {
      p.text(name)
    }).boolean()
  }
  effectiveMode(
    path: string,
    prefix: string,
    configured: MountMode,
    cap: MountMode | null,
  ): MountMode {
    return this.query(49, (p) => {
      p.text(path)
      p.text(prefix)
      p.mode(configured)
      p.optional(cap, (p, m) => {
        p.mode(m)
      })
    }).mode()
  }
  strongestMode(prefix: string, configured: MountMode, cap: MountMode | null): MountMode {
    return this.query(50, (p) => {
      p.text(prefix)
      p.mode(configured)
      p.optional(cap, (p, m) => {
        p.mode(m)
      })
    }).mode()
  }
  readonlyBelow(
    path: string,
    prefix: string,
    configured: MountMode,
    cap: MountMode | null,
  ): string | null {
    return this.query(51, (p) => {
      p.text(path)
      p.text(prefix)
      p.mode(configured)
      p.optional(cap, (p, m) => {
        p.mode(m)
      })
    }).optional((r) => r.text())
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false
  return true
}
function sameEntries<T>(
  left: readonly T[],
  right: readonly T[],
  equal: (left: T, right: T) => boolean,
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const entry = left[index],
      other = right[index]
    if (entry === undefined || other === undefined || !equal(entry, other)) return false
  }
  return true
}
function snapshotRule(rule: CommandRule): CommandRule {
  return {
    reason: rule.reason,
    commands: [...(rule.commands ?? [])],
    paths: [...(rule.paths ?? [])],
    ...(rule.mount === undefined ? {} : { mount: rule.mount }),
  }
}
function sameRule(left: CommandRule, right: CommandRule): boolean {
  return (
    left.reason === right.reason &&
    left.mount === right.mount &&
    sameStrings(left.commands ?? [], right.commands ?? []) &&
    sameStrings(left.paths ?? [], right.paths ?? [])
  )
}
function snapshotRules(rules: AdmissionRules): AdmissionRules {
  return {
    allow: rules.allow === null ? null : [...rules.allow],
    deny: rules.deny.map(snapshotRule),
    ask: rules.ask.map(snapshotRule),
  }
}
function sameRules(left: AdmissionRules, right: AdmissionRules): boolean {
  return (
    (left.allow === null
      ? right.allow === null
      : right.allow !== null && sameStrings(left.allow, right.allow)) &&
    sameEntries(left.deny, right.deny, sameRule) &&
    sameEntries(left.ask, right.ask, sameRule)
  )
}
function snapshotHidden(hidden: HiddenPaths): HiddenPaths {
  return { paths: [...(hidden.paths ?? [])], patterns: [...(hidden.patterns ?? [])] }
}
function sameHidden(left: HiddenPaths, right: HiddenPaths): boolean {
  return (
    sameStrings(left.paths ?? [], right.paths ?? []) &&
    sameStrings(left.patterns ?? [], right.patterns ?? [])
  )
}
function snapshotShown(shown: ShownPaths): ShownPaths {
  return { entries: shown.entries.map((entry) => ({ path: entry.path, mode: entry.mode })) }
}
function sameShown(left: ShownPaths, right: ShownPaths): boolean {
  return sameEntries(
    left.entries,
    right.entries,
    (entry, other) => entry.path === other.path && entry.mode === other.mode,
  )
}
function snapshotVars(vars: HiddenVars): HiddenVars {
  return { names: [...(vars.names ?? [])], patterns: [...(vars.patterns ?? [])] }
}
function sameVars(left: HiddenVars, right: HiddenVars): boolean {
  return (
    sameStrings(left.names ?? [], right.names ?? []) &&
    sameStrings(left.patterns ?? [], right.patterns ?? [])
  )
}
function sameOptional<T>(
  left: T | null,
  right: T | null,
  equal: (left: T, right: T) => boolean,
): boolean {
  return left === null ? right === null : right !== null && equal(left, right)
}
function snapshotVisibility(vis: Visibility): Visibility {
  return {
    paths: vis.paths === null ? null : snapshotHidden(vis.paths),
    shown: vis.shown === null ? null : snapshotShown(vis.shown),
    vars: vis.vars === null ? null : snapshotVars(vis.vars),
    processes: vis.processes,
  }
}
function sameVisibility(left: Visibility, right: Visibility): boolean {
  return (
    sameOptional(left.paths, right.paths, sameHidden) &&
    sameOptional(left.shown, right.shown, sameShown) &&
    sameOptional(left.vars, right.vars, sameVars) &&
    left.processes === right.processes
  )
}

class MatcherCache<K, V extends Handle> {
  private readonly values = new Map<K, { readonly matcher: V; readonly snapshot: K }>()
  constructor(
    private readonly snapshot: (key: K) => K,
    private readonly equal: (key: K, snapshot: K) => boolean,
  ) {}
  get(key: K, build: () => V): V {
    const known = this.values.get(key)
    if (known?.matcher.live && this.equal(key, known.snapshot)) {
      this.values.delete(key)
      this.values.set(key, known)
      return known.matcher
    }
    if (known !== undefined) {
      known.matcher.close()
      this.values.delete(key)
    }
    const value = build()
    this.values.set(key, { matcher: value, snapshot: this.snapshot(key) })
    if (this.values.size > CACHE_LIMIT) {
      const oldest = this.values.keys().next()
      if (!oldest.done) {
        this.values.get(oldest.value)?.matcher.close()
        this.values.delete(oldest.value)
      }
    }
    return value
  }
  clear(drop: boolean): void {
    for (const value of this.values.values()) value.matcher.close(drop)
    this.values.clear()
  }
}
const admissions = new MatcherCache<AdmissionRules, AdmissionMatcher>(snapshotRules, sameRules)
const rules = new MatcherCache<CommandRule, AdmissionMatcher>(snapshotRule, sameRule)
const visibilities = new MatcherCache<Visibility, VisibilityMatcher>(
  snapshotVisibility,
  sameVisibility,
)
const hidden = new MatcherCache<HiddenPaths, VisibilityMatcher>(snapshotHidden, sameHidden)
const shown = new MatcherCache<ShownPaths, VisibilityMatcher>(snapshotShown, sameShown)
const variables = new MatcherCache<HiddenVars, VisibilityMatcher>(snapshotVars, sameVars)
const unrestrictedRules: AdmissionRules = { allow: null, deny: [], ask: [] }
const unrestrictedVisibility: Visibility = {
  paths: null,
  shown: null,
  vars: null,
  processes: 'session',
}

function clearCaches(drop: boolean): void {
  admissions.clear(drop)
  rules.clear(drop)
  visibilities.clear(drop)
  hidden.clear(drop)
  shown.clear(drop)
  variables.clear(drop)
}
export function closePolicyMatchers(): void {
  clearCaches(true)
  current = undefined
  generation += 1
}
export function admissionMatcher(value: AdmissionRules | null): AdmissionMatcher {
  const key = value ?? unrestrictedRules
  return admissions.get(key, () => new AdmissionMatcher(key))
}
export function ruleMatcher(value: CommandRule): AdmissionMatcher {
  return rules.get(value, () => new AdmissionMatcher({ deny: [value] }))
}
export function visibilityMatcher(value: Visibility | null): VisibilityMatcher {
  const key = value ?? unrestrictedVisibility
  return visibilities.get(key, () => new VisibilityMatcher(key))
}
export function hiddenMatcher(value: HiddenPaths): VisibilityMatcher {
  return hidden.get(value, () => new VisibilityMatcher({ paths: value }))
}
export function shownMatcher(value: ShownPaths): VisibilityMatcher {
  return shown.get(value, () => new VisibilityMatcher({ shown: value }))
}
export function varsMatcher(value: HiddenVars): VisibilityMatcher {
  return variables.get(value, () => new VisibilityMatcher({ vars: value }))
}

export function policySplitPattern(pattern: string): string[] {
  return invoke(5, 0, (p) => {
    p.text(pattern)
  }).list((r) => r.text())
}
export function policyPatternMatches(pattern: string, tokens: readonly string[]): boolean {
  return invoke(6, 0, (p) => {
    p.text(pattern)
    p.list(tokens, (p, t) => {
      p.text(t)
    })
  }).boolean()
}
export function policyPatternReaches(pattern: string, tokens: readonly string[]): boolean {
  return invoke(7, 0, (p) => {
    p.text(pattern)
    p.list(tokens, (p, t) => {
      p.text(t)
    })
  }).boolean()
}
export function policyIsGlob(entry: string): boolean {
  return invoke(8, 0, (p) => {
    p.text(entry)
  }).boolean()
}
export function policyAnchorDepth(entry: string): number {
  return invoke(9, 0, (p) => {
    p.text(entry)
  }).number()
}
export function policyShowHead(entry: string): string {
  return invoke(10, 0, (p) => {
    p.text(entry)
  }).text()
}
export function policyClassifyPaths(entries: readonly string[]): HiddenPaths | null {
  return invoke(11, 0, (p) => {
    p.list(entries, (p, t) => {
      p.text(t)
    })
  }).hidden()
}
export function policyClassifyVars(entries: readonly string[]): HiddenVars | null {
  const reply = invoke(12, 0, (p) => {
    p.list(entries, (p, t) => {
      p.text(t)
    })
  })
  const names = reply.list((r) => r.text()),
    patterns = reply.list((r) => r.text())
  return names.length + patterns.length === 0 ? null : { names, patterns }
}
export function policySubjects(facts: PolicyFacts): PolicySubject[] {
  return invoke(13, 0, (p) => {
    p.facts(facts)
  }).list((r) => r.subject())
}
export function compilePolicy(profile: PolicyProfile): PolicyPlan {
  const reply = invoke(3, 0, (p) => {
    p.profile(profile)
  })
  const commands = reply.optional((r) => r.rules()),
    visibility = reply.visibility(),
    modes = reply.list((r): readonly [string, MountMode] => [r.text(), r.mode()]),
    hideReasons = reply.list((r) => r.reason())
  return {
    commands,
    visibility,
    mountModes: modes.length === 0 ? null : new Map(modes),
    hideReasons,
  }
}
export function restrictPolicy(
  base: PolicyProfile | null,
  inline: PolicyProfile | null,
): PolicyProfile | null {
  return invoke(4, 0, (p) => {
    p.optional(base, (p, v) => {
      p.profile(v)
    })
    p.optional(inline, (p, v) => {
      p.profile(v)
    })
  }).optional((r) => r.profile())
}

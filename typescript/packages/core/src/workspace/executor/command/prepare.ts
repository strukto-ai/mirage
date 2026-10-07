import type { EvaluationContext } from '../../evaluation.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import type { RouteDecision } from '../../../runtime/routing/index.ts'
import type { TSNodeLike } from '../../../shell/types.ts'
import { NodeType as NT, ProcessSubDirection } from '../../../shell/types.ts'
import { getProcessSubBody, getProcessSubDirection } from '../../../shell/helpers.ts'
import { ExitSignal } from '../../../shell/errors.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { DevVFS } from '../../../vfs/dev/dev.ts'
import type { Argv } from '../../expand/argv.ts'
import { expandArgv } from '../../expand/argv.ts'
import { type ExecuteFn, childLine } from '../../expand/node.ts'
import { sessionView } from '../../session/state.ts'

export async function ownWords<T>(node: TSNodeLike, pending: Promise<T>): Promise<T> {
  try {
    return await pending
  } catch (err) {
    if (err instanceof ExitSignal) err.expanding = node.id ?? null
    throw err
  }
}

/** Own command-word expansion and its temporary process-substitution operands. */
export class CommandPreparation {
  private dev: DevVFS | null = null
  private readonly inputs: (readonly [string, number])[] = []
  readonly diagnostics: Uint8Array[] = []

  async expand(
    node: TSNodeLike,
    parts: readonly TSNodeLike[],
    context: EvaluationContext,
    executeFn: ExecuteFn,
    callStack: CallStack | null,
    registry: MountRegistry,
    namespace: Namespace,
    routing?: RouteDecision,
  ): Promise<Argv | IOResult> {
    const cleanParts: TSNodeLike[] = []
    for (const part of parts) {
      if (part.type !== NT.PROCESS_SUBSTITUTION) {
        cleanParts.push(part)
        continue
      }
      if (getProcessSubDirection(part) === ProcessSubDirection.OUTPUT)
        return new IOResult({
          exitCode: 2,
          stderr: encodeText('mirage: unsupported: process substitution >(...)\n'),
        })
      if (this.dev === null) {
        const [candidate] = registry.resolve('/dev/null')
        if (!(candidate instanceof DevVFS)) throw new Error('missing device filesystem')
        this.dev = candidate
      }
      const [path, allocation] = this.dev.allocateInput()
      this.inputs.push([path, allocation])
      const inner = getProcessSubBody(part)
      if (inner !== '') {
        const io = await childLine(context, executeFn, inner, part, callStack)
        this.dev.setInput(path, allocation, await materialize(io.stdout))
        this.diagnostics.push(await materialize(io.stderr))
      }
      cleanParts.push({ type: NT.WORD, text: path, children: [], namedChildren: [] })
    }
    return ownWords(
      node,
      expandArgv(
        cleanParts,
        context,
        executeFn,
        callStack,
        registry,
        namespace,
        sessionView(context.session, registry.policies, context.frame.diagnostics),
        routing,
      ),
    )
  }

  async settle(stdout: ByteSource | null): Promise<ByteSource | null> {
    return this.inputs.length > 0 && stdout !== null ? materialize(stdout) : stdout
  }

  release(): void {
    for (const [path, allocation] of this.inputs) this.dev?.releaseInput(path, allocation)
    this.inputs.length = 0
  }
}

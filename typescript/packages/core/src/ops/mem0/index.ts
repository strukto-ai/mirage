import { MEM0_IO } from '../../commands/builtin/mem0/io.ts'
import { ResourceName } from '../../types.ts'
import { makeGenericOps } from '../generic/factory.ts'
import type { RegisteredOp } from '../registry.ts'

export const MEM0_OPS: readonly RegisteredOp[] = makeGenericOps(ResourceName.MEM0, MEM0_IO)

import type { JsonValue } from '../types.ts'

export const ExecutionStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  STOPPING: 'stopping',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const)
export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus]

export interface ExecutionRecord {
  readonly id: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly command: string
  readonly submittedAt: number
  readonly status: ExecutionStatus
  readonly cancelRequested: boolean
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly result: JsonValue
  readonly error: string | null
}

export interface RunVariables {
  entity: string
  project: string
  run: string
}
export interface RunUser {
  id: string
  name: string
  username: string | null
  email: string | null
}
export interface Run {
  name: string
  id?: string | null
  displayName?: string | null
  state?: string | null
  tags?: string[] | null
  sweepName?: string | null
  group?: string | null
  jobType?: string | null
  commit?: string | null
  readOnly?: boolean | null
  createdAt?: string | null
  heartbeatAt?: string | null
  description?: string | null
  notes?: string | null
  user?: RunUser | null
  systemMetrics?: string | Record<string, unknown> | null
  historyLineCount?: number | null
  fileCount?: number | null
  config?: string | Record<string, { value: unknown }>
  summaryMetrics?: string | Record<string, unknown>
  historyKeys?: { lastStep?: number; [key: string]: unknown } | null
}
export interface FileMetadata {
  name: string
  sizeBytes: number | null
}
export interface RunFile extends FileMetadata {
  directUrl?: string | null
  url: string
}

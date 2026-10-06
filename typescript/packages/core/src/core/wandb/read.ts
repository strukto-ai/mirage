import type { WandbAccessor } from '../../accessor/wandb.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { jsonBytes, jsonlBytes } from '../render/json.ts'
import { LEAVES, parts, runVars } from './pathing.ts'
import { RUN, RUN_CONFIG, RUN_SUMMARY } from './queries.ts'
import { runMetadata } from './metadata.ts'
import { stat } from './stat.ts'
export async function* readStream(
  accessor: WandbAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncGenerator<Uint8Array> {
  const ps = parts(accessor, path)
  if (ps.length > 4 && ps[3] === 'files') {
    const file = await accessor.client.file(runVars(ps), ps.slice(4).join('/'))
    if (file) {
      yield* accessor.client.download(
        file.directUrl === undefined || file.directUrl === null || file.directUrl === ''
          ? file.url
          : file.directUrl,
      )
      return
    }
  }
  if (ps.length !== 4 || !LEAVES.includes(ps[3] ?? '')) {
    const info = await stat(accessor, path, index)
    if (info.type === FileType.DIRECTORY) throw eisdir(path)
    throw enoent(path)
  }
  const variables = runVars(ps)
  if (ps[3] === 'history.jsonl') {
    for await (const row of accessor.client.history(variables)) yield jsonlBytes([row])
    return
  }
  const query = ps[3] === 'run.json' ? RUN : ps[3] === 'config.json' ? RUN_CONFIG : RUN_SUMMARY
  const run = await accessor.client.run(variables, query)
  if (ps[3] === 'run.json') yield jsonBytes(runMetadata(run, variables))
  else if (ps[3] === 'config.json') {
    const raw = run.config === '' ? '{}' : (run.config ?? '{}')
    const config =
      typeof raw === 'string' ? (JSON.parse(raw) as Record<string, { value: unknown }>) : raw
    yield jsonBytes(Object.fromEntries(Object.entries(config).map(([k, v]) => [k, v.value])))
  } else {
    const raw = run.summaryMetrics === '' ? '{}' : (run.summaryMetrics ?? '{}')
    yield jsonBytes(typeof raw === 'string' ? JSON.parse(raw) : raw)
  }
}
export async function read(
  accessor: WandbAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of readStream(accessor, path, index)) {
    chunks.push(chunk)
    size += chunk.length
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

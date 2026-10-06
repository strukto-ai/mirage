import type { NotionAccessor } from '../../accessor/notion.ts'
import { enoent } from '../../errors/fs.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { NotionAPIError } from './client.ts'
import { pageSegmentName } from './normalize.ts'
import { getPage } from './pages.ts'

/** Fetch and validate the row named by a path, including descendants. */
export async function resolveRow(
  accessor: NotionAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<Record<string, unknown>> {
  let page: Record<string, unknown>
  try {
    page = await getPage(accessor.transport, match.slots.row_id ?? '')
  } catch (err) {
    if (err instanceof NotionAPIError && (err.status === 404 || err.code === 'validation_error')) {
      throw enoent(virtual)
    }
    throw err
  }
  const parent = page.parent as Record<string, unknown> | undefined
  const name = `${match.slots.row ?? ''}__${match.slots.row_id ?? ''}`
  if (
    parent?.data_source_id !== match.slots.data_source_id ||
    page.in_trash === true ||
    page.archived === true ||
    pageSegmentName(page) !== name
  )
    throw enoent(virtual)
  return page
}

/** Validate a containing row when this path has one. */
export async function guardRow(
  accessor: NotionAccessor,
  match: ScopeMatch,
  virtual: string,
): Promise<void> {
  if (match.slots.row_id !== undefined) await resolveRow(accessor, match, virtual)
}

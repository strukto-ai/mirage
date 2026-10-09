export type LanceRow = Record<string, unknown>

/** A test on one value's text that a capped scan counts in place of rows. */
export type ValueTest = (value: string) => boolean

export interface LanceDriver {
  listTables(): Promise<string[]>
  tableColumns(table: string): Promise<string[]>
  /**
   * The distinct values of one group column, as text.
   *
   * Without a test the limit bounds the rows, which is the ordinary capped
   * listing over the head of the table. With one it bounds the MATCHES: the
   * prefix a glob narrows the query to loses nothing, but it can let through
   * rows the glob does not match (a head cut inside an escape pair decodes to
   * a shorter value prefix) or narrow nothing at all (a head that is only the
   * escape lead), and those rows would fill the cap and hide every match past
   * it. A glob is a targeted request, so it pays a scan up to its matches
   * where the plain listing pays one window.
   */
  distinct(
    table: string,
    column: string,
    filters: Record<string, string>,
    limit: number,
    prefix?: string,
    keep?: ValueTest,
  ): Promise<string[]>
  rowsMatching(
    table: string,
    filters: Record<string, string>,
    columns: string[],
    limit: number,
    idColumn?: string,
    prefix?: string,
  ): Promise<LanceRow[]>
  rowRecord(table: string, idColumn: string, rowId: string): Promise<LanceRow | null>
  search(table: string, query: string, limit: number): Promise<LanceRow[]>
  close(): Promise<void>
}

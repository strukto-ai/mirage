// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

export type LanceRow = Record<string, unknown>

export interface LanceDriver {
  listTables(): Promise<string[]>
  tableColumns(table: string): Promise<string[]>
  distinct(
    table: string,
    column: string,
    filters: Record<string, string>,
    limit: number,
  ): Promise<string[]>
  rowsMatching(
    table: string,
    filters: Record<string, string>,
    columns: string[],
    limit: number,
  ): Promise<LanceRow[]>
  rowRecord(table: string, idColumn: string, rowId: string): Promise<LanceRow | null>
  search(table: string, query: string, limit: number): Promise<LanceRow[]>
  close(): Promise<void>
}

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

export const GSHEETS_PROMPT = `{prefix}
  owned/
    <date>_<title>__<spreadsheet-id>.gsheet.json
  shared/
    <date>_<title>__<spreadsheet-id>.gsheet.json

  Filename: <YYYY-MM-DD>_<title>__<spreadsheet-id>.gsheet.json
    <YYYY-MM-DD>      modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>           sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <spreadsheet-id>  Google Sheets spreadsheet ID

  Buckets:
    owned/   sheets you created
    shared/  sheets shared with you by others
             - does NOT include sheets you own and shared with others;
               those are still in owned/.

  gsheet.json structure (matches the Google Sheets API spreadsheets.get response):
    {
      "spreadsheetId": "...",
      "spreadsheetUrl": "...",
      "properties": { "title": "...", "locale": "...", "timeZone": "..." },
      "sheets": [
        {                                      # one element per tab
          "properties": {
            "sheetId": 0, "title": "...", "index": 0,
            "gridProperties": { "rowCount": 1000, "columnCount": 26 }
          },
          "data": [
            {
              "rowData": [
                { "values": [
                    { "formattedValue": "...",
                      "userEnteredValue": {...},
                      "effectiveValue": {...} }
                ]}    # empty cells are omitted, not nullified
              ]
            }
          ]
        }
      ],
      "namedRanges": [...]
    }

  Useful jq paths:
    .properties.title
    .sheets[].properties.title                              # tab names
    .sheets[0].data[0].rowData[].values[].formattedValue    # cell strings
    .namedRanges[]

  Read commands (alternative to cat for range-scoped reads — lighter):
    gws sheets +read --spreadsheet <id> --range Sheet1!A1:C10`

export const GSHEETS_WRITE_PROMPT = `  Write commands:
    gws sheets +write --spreadsheet <id> --range Sheet1!A1:B2 \\
      --json-values '[["Name", "Score"], ["Alice", 42]]'

    gws sheets +append --spreadsheet <id> --range Sheet1!A1 \\
      --values "Bob,37"                          # comma-separated single row
    gws sheets +append --spreadsheet <id> --range Sheet1!A1 \\
      --json-values '[["Bob", 37], ["Carol", 51]]'   # multiple rows

    gws sheets spreadsheets create \\
      --json '{"properties": {"title": "Q2 Budget"}}'

    gws sheets spreadsheets batchUpdate \\
      --params '{"spreadsheetId": "<id>"}' \\
      --json   '{"requests": [{"addSheet": {"properties": {"title": "Q3"}}}]}'

  Delete:
    rm {prefix}/owned/<file>.gsheet.json     # permanent delete from Drive
    rm -f <path>                             # ignore if missing
    Only operates on .gsheet.json files; owned/ and shared/ themselves
    cannot be removed.`

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

export const PROMPT = `{prefix}
  bases/
    <base-name>__<base-id>/
      base.json                    base id, name, permission, table list
      <table-name>__<table-id>/
        table.json                 typed fields (with options) and views
        records.jsonl              one record per line
        views/
          <view-name>__<view-id>.jsonl   records the view shows, in its order
  Always ls directories first to discover exact names: the name part of
  a segment is sanitized, the id after the LAST "__" is exact.

  A records.jsonl line is a mirage-normalized record:
    record_id, created_time, and fields (keyed by field NAME, values as
    Airtable returns them). Read table.json for each field's type.
  Airtable omits empty cells, so a missing key means empty (checkbox
  false included). A link field is a list of record ids; an attachment
  url expires two hours after it was read.
  records.jsonl lists in the API's own order; a view file applies the
  view's filter and sort. A file over max_read_records records stops
  with File too large after that many, while head -n N fetches just N
  records:
    head -n 20 {prefix}/bases/<base>/<table>/records.jsonl | jq .fields
  The airtable CLI, if installed, reaches what a file cannot: server-side
  filters (airtable record list --formula or --view), one record by id
  (airtable record get), and comments (airtable comment list).`

export const WRITE_PROMPT = `  Writes go through the airtable CLI if installed; a record line is the
  records.jsonl shape, and the ids are the ones after the LAST "__":
    airtable record create --base <base-id> --table <table-id> \\
      --fields '{"Name": "New feature"}'
    jq -c 'select(.fields.Status == "Todo") | .fields.Status = "Done"' \\
      {prefix}/bases/<base>/<table>/records.jsonl \\
      | airtable record update --base <base-id> --table <table-id>
    airtable comment add --base <base-id> --table <table-id> <record-id> \\
      --text "comment"
  See airtable --help for every verb.`

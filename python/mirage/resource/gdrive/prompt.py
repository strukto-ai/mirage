# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

PROMPT = """\
{prefix}
  Mirrors Google Drive folder hierarchy. May contain:
    <name>.gdoc.json    Google Docs    (cat returns gdoc.json - see /gdocs prompt)
    <name>.gsheet.json  Google Sheets  (cat returns gsheet.json - see /gsheets prompt)
    <name>.gslide.json  Google Slides  (cat returns gslide.json - see /gslides prompt)
    <other-files>       PDFs, images, etc. - cat returns raw bytes

  No owned/ vs shared/ split here: gdrive shows the user's full Drive view,
  including files shared with the user that have been added to My Drive.
  Shared drives visible to the user are included as top-level directories.

  IMPORTANT: This is a remote mount. Prefer targeted reads over full scans.
  Date-prefixed globs (2026-05-*) push to a Drive modifiedTime range query.

  All gws-* commands from /gdocs, /gsheets, /gslides also work here
  (the per-service prompts have flag examples)."""

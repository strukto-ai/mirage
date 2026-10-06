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

BOX_TOKEN_URL = "https://api.box.com/oauth2/token"
BOX_API_BASE = "https://api.box.com/2.0"
BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0"
TOKEN_BUFFER_SECONDS = 300

# The user event stream the watch hooks read: ``changes`` is the one Box
# documents as carrying file tree changes, without the downloads and
# previews ``all`` adds.
EVENT_STREAM = "changes"
# Box keeps user events for between two weeks and two months, and a
# position older than that is not refused, it just replays what is left.
# A snapshot walked this long ago is walked again, which bounds both the
# age of the position and how long an event Box repeated or delivered out
# of order can leave the snapshot wrong.
EVENT_REPLAY_DAYS = 14
# Events that put an item at the path its ``source`` names.
PLACE_EVENTS = frozenset(
    {
        "ITEM_CREATE",
        "ITEM_UPLOAD",
        "ITEM_COPY",
        "ITEM_MOVE",
        "ITEM_RENAME",
        "ITEM_UNDELETE_VIA_TRASH",
        "ITEM_MAKE_CURRENT_VERSION",
    }
)
TRASH_EVENTS = frozenset({"ITEM_TRASH"})

SHA1 = "sha1"
ACTIVE = "active"
ALL_FILES_FOLDER_ID = "0"
TRASH_FOLDER_ID = "1"

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

PAGE_SIZE = 100

WEBHOOK_PAGE_SIZE = 50

# Metadata calls (the base listing) are metered per account rather than
# per base; they pace under their own key.
META_KEY = "meta"

# A view is looked up by id when the value is shaped like one, and by name
# otherwise; each miss has its own type.
NOT_FOUND_TYPES = frozenset(
    {
        "NOT_FOUND",
        "MODEL_ID_NOT_FOUND",
        "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
        "VIEW_ID_NOT_FOUND",
        "VIEW_NAME_NOT_FOUND",
    }
)

# Airtable takes at most ten records in one create, update or delete.
MAX_BATCH = 10

VIEW_SUFFIX = ".jsonl"

# The keys of one records.jsonl line, the only ones a write reads back.
LINE_KEYS = frozenset({"record_id", "created_time", "fields"})

# The field types Airtable computes and refuses a write to. A mount line
# carries every one of them, so a line piped back drops them first.
COMPUTED_TYPES = frozenset(
    {
        "aiText",
        "autoNumber",
        "button",
        "count",
        "createdBy",
        "createdTime",
        "externalSyncSource",
        "formula",
        "lastModifiedBy",
        "lastModifiedTime",
        "lookup",
        "multipleLookupValues",
        "rollup",
    }
)

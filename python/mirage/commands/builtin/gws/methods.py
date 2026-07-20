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

from collections.abc import Callable
from dataclasses import dataclass

from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.google._client import (TokenManager, docs_base, drive_base,
                                        gmail_base, sheets_base, slides_base)

# The official gws CLI generates one command per Discovery method and
# speaks raw API resources: `--params` carries path/query parameters,
# `--json` the request body, and the output is the API response JSON.
# Each entry here is one such passthrough method; the bespoke gws_*
# commands (create/batchUpdate/+read/+append/+write) stay hand-written.


@dataclass(frozen=True, slots=True)
class GwsMethod:
    service: str
    resource: str
    method: str
    http: str
    path: str
    needs_body: bool = False
    raw_bytes: bool = False

    @property
    def command_name(self) -> str:
        return f"gws {self.service} {self.resource} {self.method}"


GWS_METHODS: tuple[GwsMethod, ...] = (
    GwsMethod("docs", "documents", "get", "GET", "/documents/{documentId}"),
    GwsMethod("docs",
              "documents",
              "create",
              "POST",
              "/documents",
              needs_body=True),
    GwsMethod("docs",
              "documents",
              "batchUpdate",
              "POST",
              "/documents/{documentId}:batchUpdate",
              needs_body=True),
    GwsMethod("sheets", "spreadsheets", "get", "GET",
              "/spreadsheets/{spreadsheetId}"),
    GwsMethod("sheets",
              "spreadsheets",
              "create",
              "POST",
              "/spreadsheets",
              needs_body=True),
    GwsMethod("sheets",
              "spreadsheets",
              "batchUpdate",
              "POST",
              "/spreadsheets/{spreadsheetId}:batchUpdate",
              needs_body=True),
    GwsMethod("slides", "presentations", "get", "GET",
              "/presentations/{presentationId}"),
    GwsMethod("slides",
              "presentations",
              "create",
              "POST",
              "/presentations",
              needs_body=True),
    GwsMethod("slides",
              "presentations",
              "batchUpdate",
              "POST",
              "/presentations/{presentationId}:batchUpdate",
              needs_body=True),
    GwsMethod("drive", "files", "list", "GET", "/files"),
    GwsMethod("drive", "files", "get", "GET", "/files/{fileId}"),
    GwsMethod("drive", "files", "create", "POST", "/files", needs_body=True),
    GwsMethod("drive",
              "files",
              "update",
              "PATCH",
              "/files/{fileId}",
              needs_body=True),
    GwsMethod("drive", "files", "copy", "POST", "/files/{fileId}/copy"),
    GwsMethod("drive", "files", "delete", "DELETE", "/files/{fileId}"),
    GwsMethod("drive",
              "files",
              "export",
              "GET",
              "/files/{fileId}/export",
              raw_bytes=True),
    GwsMethod("drive",
              "permissions",
              "create",
              "POST",
              "/files/{fileId}/permissions",
              needs_body=True),
    GwsMethod("drive", "permissions", "list", "GET",
              "/files/{fileId}/permissions"),
    GwsMethod("drive", "permissions", "delete", "DELETE",
              "/files/{fileId}/permissions/{permissionId}"),
    GwsMethod("gmail", "users labels", "list", "GET",
              "/users/{userId}/labels"),
    GwsMethod("gmail", "users messages", "list", "GET",
              "/users/{userId}/messages"),
    GwsMethod("gmail", "users messages", "get", "GET",
              "/users/{userId}/messages/{id}"),
    GwsMethod("gmail",
              "users messages",
              "send",
              "POST",
              "/users/{userId}/messages/send",
              needs_body=True),
    GwsMethod("gmail", "users messages", "trash", "POST",
              "/users/{userId}/messages/{id}/trash"),
    GwsMethod("gmail", "users messages attachments", "get", "GET",
              "/users/{userId}/messages/{messageId}/attachments/{id}"),
)

GWS_API_SPEC = CommandSpec(options=(
    Option(long="--params", value_kind=OperandKind.TEXT),
    Option(long="--json", value_kind=OperandKind.TEXT),
), )

SERVICE_BASES: dict[str, Callable[[TokenManager], str]] = {
    "drive": drive_base,
    "docs": docs_base,
    "sheets": sheets_base,
    "slides": slides_base,
    "gmail": gmail_base,
}

SERVICE_RESOURCES: dict[str, list[str]] = {
    "drive": ["gdrive"],
    "docs": ["gdocs", "gdrive"],
    "sheets": ["gsheets", "gdrive"],
    "slides": ["gslides", "gdrive"],
    "gmail": ["gmail"],
}

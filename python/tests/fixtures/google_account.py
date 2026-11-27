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

import base64
import json
import re
from collections.abc import AsyncIterator
from typing import Any, NamedTuple, TypeVar
from urllib.parse import parse_qs, quote, unquote

import pytest_asyncio
from pydantic import SecretStr

from mirage.accessor.gdrive import GDriveAccessor
from mirage.accessor.gmail import GmailAccessor
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.google.drive import FOLDER_MIME
from mirage.utils.clock import Clock
from mirage.vfs.gmail.config import GmailConfig
from tests.fixtures.kit_fake import KitRun

TOKEN = "gws-integ-token"
FILE_MIME = "application/octet-stream"
FILES = "/drive/v3/files"
FILE = "/drive/v3/files/:id"
DRIVES = "/drive/v3/drives"
UPLOAD = "/upload/drive/v3/files"
UPLOAD_FILE = "/upload/drive/v3/files/:id"
REVISION = "/drive/v3/files/:id/revisions/:revisionId"
MEDIA_QUERY = "alt=media&supportsAllDrives=true"
CALENDARS = "/calendar/v3/calendars"
EVENTS = "/calendar/v3/calendars/:calendarId/events"
EVENT = "/calendar/v3/calendars/:calendarId/events/:eventId"
PRIMARY = "integ@example.com"
GMAIL = "/gmail/v1/users/me"
MESSAGES = "/gmail/v1/users/me/messages"
MESSAGE = "/gmail/v1/users/me/messages/:id"
HISTORY = "/gmail/v1/users/me/history"
UNTIL_CLEARED = 1_000_000
BOUNDARY = "mirage-test-part"
PARENTS = re.compile(r"'((?:[^'\\]|\\.)*)' in parents")
TEXT = re.compile(r"fullText contains '((?:[^'\\]|\\.)*)'")
Config = TypeVar("Config", bound=GoogleConfig)


class Listing(NamedTuple):
    """One Drive listing a client asked for.

    ``folders`` are the folders its query names, ``drive`` the shared
    drive it is asked in, ``page_size`` the largest page it takes,
    ``level`` whether it asks a whole level of folders at once (as a tree
    walk does) rather than one folder, ``text`` the words a full-text
    search asks for, and ``query`` its query string as sent."""

    folders: list[str]
    drive: str | None
    page_size: int
    level: bool
    text: str | None
    query: str


class GoogleAccount:
    """One account on the Google Workspace fake, and what a test arranges
    its Drive, its calendars and its mailbox by.

    Every change is the request a client of the service makes, so each id,
    time, checksum and revision is one the fake hands out, as Google's are.

    Args:
        origin (str): the Workspace fake's origin.
    """

    def __init__(self, origin: str) -> None:
        self.run = KitRun(origin, {"Authorization": f"Bearer {TOKEN}"})

    def config(
        self, model: type[Config] = GoogleConfig, **fields: Any
    ) -> Config:
        """A config of ``model`` signed in to this account.

        Args:
            model (type[Config]): GoogleConfig or a mount's config.
            **fields (Any): further fields of it.
        """
        return model(
            access_token=SecretStr(TOKEN), api_base=self.run.url, **fields
        )

    def token_manager(
        self, clock: Clock | None = None, **fields: Any
    ) -> TokenManager:
        """A token manager signed in to this account.

        Args:
            clock (Clock | None): the clock its retries wait on; None is
                the system clock.
            **fields (Any): further GoogleConfig fields.
        """
        return TokenManager(self.config(**fields), clock)

    def drive_accessor(
        self, clock: Clock | None = None, **fields: Any
    ) -> GDriveAccessor:
        """A Drive accessor signed in to this account.

        Args:
            clock (Clock | None): the clock its retries wait on; None is
                the system clock.
            **fields (Any): further GoogleConfig fields, ``folder_id``
                for a mount scoped to a folder.
        """
        manager = self.token_manager(clock, **fields)
        return GDriveAccessor(config=manager.config, token_manager=manager)

    def gmail_accessor(
        self, clock: Clock | None = None, **fields: Any
    ) -> GmailAccessor:
        """A Gmail accessor signed in to this account.

        Args:
            clock (Clock | None): the clock its retries wait on; None is
                the system clock.
            **fields (Any): further GmailConfig fields.
        """
        config = self.config(GmailConfig, **fields)
        return GmailAccessor(config, TokenManager(config, clock))

    async def folder(self, name: str, parent: str = "root") -> str:
        """Make a folder in ``parent`` and return its id.

        Args:
            name (str): the folder's name.
            parent (str): the folder or shared drive it goes in.
        """
        return await self.create(name, FOLDER_MIME, parent)

    async def create(self, name: str, mime: str, parent: str = "root") -> str:
        """Make an item with no content, a folder or a Docs, Sheets or
        Slides file, in ``parent`` and return its id.

        Args:
            name (str): the item's name.
            mime (str): its MIME type.
            parent (str): the folder or shared drive it goes in.
        """
        made = await self.run.call(
            "POST",
            FILES,
            json={"name": name, "mimeType": mime, "parents": [parent]},
        )
        return str(made["id"])

    async def upload(
        self,
        name: str,
        data: bytes = b"",
        parent: str = "root",
        mime: str = FILE_MIME,
    ) -> str:
        """Upload a file holding ``data`` to ``parent`` and return its id.

        Args:
            name (str): the file's name.
            data (bytes): its bytes.
            parent (str): the folder or shared drive it goes in.
            mime (str): its MIME type.
        """
        metadata = json.dumps(
            {"name": name, "mimeType": mime, "parents": [parent]}
        )
        body = (
            (
                f"--{BOUNDARY}\r\nContent-Type: application/json\r\n\r\n"
                f"{metadata}\r\n--{BOUNDARY}\r\nContent-Type: {mime}\r\n\r\n"
            ).encode()
            + data
            + f"\r\n--{BOUNDARY}--\r\n".encode()
        )
        made = await self.run.call(
            "POST",
            UPLOAD,
            params={"uploadType": "multipart"},
            data=body,
            headers={
                "Content-Type": f"multipart/related; boundary={BOUNDARY}"
            },
        )
        return str(made["id"])

    async def put(self, path: str, data: bytes) -> str:
        """Upload ``data`` at ``path`` in My Drive, making each folder on
        the way that is not there yet, and return the file's id; a file
        already at the path takes the bytes as a new revision.

        Args:
            path (str): the file's path, its folders by name.
            data (bytes): its content.
        """
        *folders, name = path.strip("/").split("/")
        parent = "root"
        for folder in folders:
            held = [
                row["id"]
                for row in (await self.listing(parent))["files"]
                if row["name"] == folder and row["mimeType"] == FOLDER_MIME
            ]
            parent = held[0] if held else await self.folder(folder, parent)
        files = [
            row["id"]
            for row in (await self.listing(parent))["files"]
            if row["name"] == name and row["mimeType"] != FOLDER_MIME
        ]
        if files:
            await self.update(files[0], data)
            return files[0]
        return await self.upload(name, data, parent)

    async def update(self, file_id: str, data: bytes) -> dict[str, Any]:
        """Replace a file's bytes, a new revision, and return it as Drive
        answers it.

        Args:
            file_id (str): the file.
            data (bytes): its new bytes.
        """
        made: dict[str, Any] = await self.run.call(
            "PATCH",
            f"{UPLOAD}/{file_id}",
            params={"uploadType": "media"},
            data=data,
        )
        return made

    async def patch(self, file_id: str, **body: Any) -> dict[str, Any]:
        """Change an item's metadata and return it as Drive answers it.

        Args:
            file_id (str): the item.
            **body (Any): the fields to change.
        """
        made: dict[str, Any] = await self.run.call(
            "PATCH", f"{FILES}/{file_id}", json=body
        )
        return made

    async def delete(self, file_id: str) -> None:
        """Delete an item, and everything in it for a folder.

        Args:
            file_id (str): the item.
        """
        await self.run.call("DELETE", f"{FILES}/{file_id}")

    async def shared_drive(self, name: str) -> str:
        """Make a shared drive and return its id, which is also the id of
        the folder at its top.

        Args:
            name (str): the drive's name.
        """
        made = await self.run.call("POST", DRIVES, json={"name": name})
        return str(made["id"])

    async def item(self, file_id: str) -> dict[str, Any]:
        """An item as Drive answers a request for it.

        Args:
            file_id (str): the item.
        """
        made: dict[str, Any] = await self.run.call("GET", f"{FILES}/{file_id}")
        return made

    async def listing(
        self, folder_id: str = "root", drive_id: str | None = None
    ) -> dict[str, Any]:
        """What Drive answers for a listing of a folder's untrashed items,
        every page of it as one answer.

        Args:
            folder_id (str): the folder.
            drive_id (str | None): its shared drive, None for My Drive.
        """
        params = {"q": f"'{folder_id}' in parents and trashed=false"}
        if drive_id is not None:
            params |= {
                "driveId": drive_id,
                "includeItemsFromAllDrives": "true",
            }
        return await self._every_page(params)

    async def _every_page(self, params: dict[str, str]) -> dict[str, Any]:
        """A files listing asked page by page until Drive hands out no
        next page token, its files gathered into the last answer.

        Args:
            params (dict[str, str]): the listing's query.
        """
        files: list[dict[str, Any]] = []
        while True:
            made: dict[str, Any] = await self.run.call(
                "GET", FILES, params=params
            )
            files.extend(made["files"])
            token = made.get("nextPageToken")
            if token is None:
                return {**made, "files": files}
            params = {**params, "pageToken": token}

    async def refuse(
        self,
        method: str,
        route: str,
        status: int,
        message: str,
        reason: str = "forbidden",
        times: int = 1,
        path: str | None = None,
    ) -> None:
        """Answer the next ``times`` requests to ``route`` with Drive's
        refusal.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
            status (int): the status to answer.
            message (str): Google's message.
            reason (str): the reason Google gives, which tells a rate
                limit from a refusal.
            times (int): how many requests it answers.
            path (str | None): the one path it answers; any if None.
        """
        error = {"message": message, "domain": "global", "reason": reason}
        body = {
            "error": {"code": status, "message": message, "errors": [error]}
        }
        await self.run.answer_next(
            method, route, status, body, times=times, path=path
        )

    async def reset(self, epoch: str | None = None, **extras: Any) -> None:
        """Start the run afresh in the fake's base world: the account's own
        primary calendar and its mailbox's system labels, which no request
        makes, so a test reading either calls this first.

        Args:
            epoch (str | None): the instant the run's clock starts at, an
                RFC 3339 time; None starts it now.
            **extras (Any): further states no request makes, as
                ``calendars``.
        """
        body: dict[str, Any] = {"extras": extras}
        if epoch is not None:
            body["epoch"] = epoch
        await self.run.call("POST", "/reset", json=body)

    async def calendars(self, *entries: dict[str, Any]) -> None:
        """Give the account the calendars ``entries`` name, each with its
        role and its events: a calendar another account shares, and the
        role it is shared with, is a state no request makes, so it rides
        the fake's reset. The run starts afresh, so this comes first.

        Args:
            *entries (dict[str, Any]): each calendar's ``id``, ``summary``,
                ``timeZone``, ``accessRole`` and ``events``.
        """
        await self.reset(calendars=list(entries))

    async def event(
        self,
        summary: str,
        start: str,
        end: str,
        calendar: str = PRIMARY,
        event_id: str | None = None,
        **fields: Any,
    ) -> str:
        """Make an event and return its id; a ``YYYY-MM-DD`` pair is an
        all-day event.

        Args:
            summary (str): its title.
            start (str): RFC3339 start, or the first all-day date.
            end (str): RFC3339 end, or the exclusive all-day end date.
            calendar (str): the calendar it goes in.
            event_id (str | None): the id to give it; one the fake mints
                if None.
            **fields (Any): further fields, as ``description``.
        """
        key = "date" if len(start) == 10 else "dateTime"
        body: dict[str, Any] = {
            "summary": summary,
            "start": {key: start},
            "end": {key: end},
            **fields,
        }
        if event_id is not None:
            body["id"] = event_id
        made = await self.run.call(
            "POST", f"{CALENDARS}/{quote(calendar, safe='')}/events", json=body
        )
        return str(made["id"])

    async def change_event(
        self, event_id: str, calendar: str = PRIMARY, **fields: Any
    ) -> None:
        """Change an event's fields.

        Args:
            event_id (str): the event.
            calendar (str): the calendar it is in.
            **fields (Any): the fields to change.
        """
        await self.run.call(
            "PATCH",
            f"{CALENDARS}/{quote(calendar, safe='')}/events/{event_id}",
            json=fields,
        )

    async def delete_event(
        self, event_id: str, calendar: str = PRIMARY
    ) -> None:
        """Delete an event.

        Args:
            event_id (str): the event.
            calendar (str): the calendar it is in.
        """
        await self.run.call(
            "DELETE",
            f"{CALENDARS}/{quote(calendar, safe='')}/events/{event_id}",
        )

    async def event_item(
        self, event_id: str, calendar: str = PRIMARY
    ) -> dict[str, Any]:
        """An event as Calendar answers a request for it, in its
        calendar's zone.

        Args:
            event_id (str): the event.
            calendar (str): the calendar it is in.
        """
        made: dict[str, Any] = await self.run.call(
            "GET", f"{CALENDARS}/{quote(calendar, safe='')}/events/{event_id}"
        )
        return made

    async def change_calendar(
        self, calendar: str = PRIMARY, **fields: Any
    ) -> None:
        """Change a calendar's own details, as ``summary`` or ``timeZone``.

        Args:
            calendar (str): the calendar, one the account owns.
            **fields (Any): the fields to change.
        """
        await self.run.call(
            "PATCH", f"{CALENDARS}/{quote(calendar, safe='')}", json=fields
        )

    async def sync_token(self, calendar: str = PRIMARY) -> str:
        """The sync token a whole listing of the calendar ends with now; only
        the last page hands one out.

        Args:
            calendar (str): the calendar.
        """
        events = f"{CALENDARS}/{quote(calendar, safe='')}/events"
        params: dict[str, str] = {}
        while True:
            made = await self.run.call("GET", events, params=params)
            if "nextSyncToken" in made:
                return str(made["nextSyncToken"])
            params = {"pageToken": made["nextPageToken"]}

    async def calendar_log(self) -> list[tuple[str, ...]]:
        """Each Calendar request made since recording started: an events
        listing ``("list", calendar, timeMin, timeMax)``, with None for a
        bound it leaves open, a search ``("search", calendar, q)``, and a
        deletion ``("delete", calendar, event)``; any other request is
        named by its method and route, with its path."""
        named: list[tuple[str, ...]] = []
        listed = await self.run.call("GET", "/_kit/requests")
        for r in listed["requests"]:
            parts = [unquote(p) for p in r["path"].split("/")]
            query = parse_qs(r["query"])
            if r["method"] == "GET" and r["route"] == EVENTS:
                if "q" in query:
                    named.append(("search", parts[4], query["q"][0]))
                else:
                    named.append(
                        (
                            "list",
                            parts[4],
                            query.get("timeMin", [None])[0],
                            query.get("timeMax", [None])[0],
                        )
                    )
            elif r["method"] == "DELETE" and r["route"] == EVENT:
                named.append(("delete", parts[4], parts[6]))
            else:
                named.append((f"{r['method']} {r['route']}", r["path"]))
        return named

    async def message(
        self,
        subject: str,
        body: str,
        labels: tuple[str, ...] = ("INBOX",),
        sender: str = "Ana <ana@example.com>",
        date: str = "Mon, 5 Jan 2026 09:00:00 +0000",
        to: str = "me@example.com",
        attachments: tuple[tuple[str, str, bytes], ...] = (),
    ) -> str:
        """Put a message in the mailbox, dated by its Date header, and
        return its id.

        Args:
            subject (str): its Subject.
            body (str): its text.
            labels (tuple[str, ...]): the labels it carries, by name; one
                the mailbox has not is made.
            sender (str): its From.
            date (str): its Date, which is the time Gmail files it at.
            to (str): its To.
            attachments (tuple[tuple[str, str, bytes], ...]): each one's
                file name, MIME type and bytes.
        """
        mark = "mirage-test-mail"
        parts = [
            f"--{mark}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
            f"{body}\r\n"
        ]
        for filename, mime, data in attachments:
            encoded = base64.b64encode(data).decode()
            parts.append(
                f'--{mark}\r\nContent-Type: {mime}; name="{filename}"\r\n'
                f'Content-Disposition: attachment; filename="{filename}"\r\n'
                f"Content-Transfer-Encoding: base64\r\n\r\n{encoded}\r\n"
            )
        raw = (
            f"From: {sender}\r\nTo: {to}\r\nSubject: {subject}\r\n"
            f"Date: {date}\r\nMIME-Version: 1.0\r\n"
            f'Content-Type: multipart/mixed; boundary="{mark}"\r\n\r\n'
            + "".join(parts)
            + f"--{mark}--\r\n"
        )
        made = await self.run.call(
            "POST",
            MESSAGES,
            params={"internalDateSource": "dateHeader"},
            json={
                "raw": base64.urlsafe_b64encode(raw.encode()).decode(),
                "labelIds": list(labels),
            },
        )
        return str(made["id"])

    async def mail(self, message_id: str) -> dict[str, Any]:
        """A message as Gmail answers a request for it in full.

        Args:
            message_id (str): the message.
        """
        made: dict[str, Any] = await self.run.call(
            "GET", f"{GMAIL}/messages/{message_id}", params={"format": "full"}
        )
        return made

    async def trash(self, message_id: str) -> None:
        """Move a message to the trash.

        Args:
            message_id (str): the message.
        """
        await self.run.call("POST", f"{MESSAGES}/{message_id}/trash")

    async def modify(
        self,
        message_id: str,
        add: tuple[str, ...] = (),
        remove: tuple[str, ...] = (),
    ) -> None:
        """Add labels to a message and take others off it.

        Args:
            message_id (str): the message.
            add (tuple[str, ...]): the label ids it gains.
            remove (tuple[str, ...]): the label ids it loses.
        """
        await self.run.call(
            "POST",
            f"{MESSAGES}/{message_id}/modify",
            json={"addLabelIds": list(add), "removeLabelIds": list(remove)},
        )

    async def delete_message(self, message_id: str) -> None:
        """Delete a message for good.

        Args:
            message_id (str): the message.
        """
        await self.run.call("DELETE", f"{MESSAGES}/{message_id}")

    async def rename_label(self, label_id: str, name: str) -> None:
        """Rename a user label.

        Args:
            label_id (str): the label.
            name (str): its new name.
        """
        await self.run.call(
            "PATCH", f"{GMAIL}/labels/{label_id}", json={"name": name}
        )

    async def delete_label(self, label_id: str) -> None:
        """Delete a user label, which every message holding it loses.

        Args:
            label_id (str): the label.
        """
        await self.run.call("DELETE", f"{GMAIL}/labels/{label_id}")

    async def label(self, name: str) -> str:
        """Make a user label and return its id.

        Args:
            name (str): its name.
        """
        made = await self.run.call(
            "POST", f"{GMAIL}/labels", json={"name": name}
        )
        return str(made["id"])

    async def history_id(self) -> str:
        """The history id the mailbox is at."""
        made = await self.run.call("GET", f"{GMAIL}/profile")
        return str(made["historyId"])

    async def find(self, name: str) -> dict[str, Any] | None:
        """The untrashed item named ``name`` in My Drive, as Drive answers
        it; None when there is none.

        Args:
            name (str): the item's name.
        """
        literal = name.replace("\\", "\\\\").replace("'", "\\'")
        q = f"name = '{literal}' and trashed = false"
        made = await self.run.call("GET", FILES, params={"q": q})
        return made["files"][0] if made["files"] else None

    async def items(self) -> list[dict[str, Any]]:
        """Every untrashed item in My Drive, as Drive answers them."""
        made = await self._every_page(
            {"q": "trashed = false", "pageSize": "1000"}
        )
        return list(made["files"])

    async def content(self, file_id: str) -> bytes:
        """The bytes a file holds now.

        Args:
            file_id (str): the file.
        """
        return await self.run.read(
            f"{FILES}/{file_id}", params={"alt": "media"}
        )

    async def asked(self, method: str, route: str) -> list[dict[str, Any]]:
        """Each request to ``route`` since recording started, as the fake
        lists it: its path, its query string as sent, its body.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
        """
        listed = await self.run.call("GET", "/_kit/requests")
        return [
            r
            for r in listed["requests"]
            if r["method"] == method and r["route"] == route
        ]

    async def listings(self) -> list[Listing]:
        """Each Drive listing asked since recording started, in order."""
        made = []
        for r in await self.asked("GET", FILES):
            query = parse_qs(r["query"])
            q = query.get("q", [""])[0]
            text = TEXT.search(q)
            made.append(
                Listing(
                    folders=PARENTS.findall(q),
                    drive=query.get("driveId", [None])[0],
                    page_size=int(query.get("pageSize", ["0"])[0]),
                    level=q.startswith("("),
                    text=text.group(1) if text else None,
                    query=r["query"],
                )
            )
        return made

    async def log(self) -> list[tuple[str, str]]:
        """Each request made since recording started, as ``(name,
        detail)``.

        A listing is ``list`` with the folders its query names joined by
        commas, an item ``get`` and its bytes ``media``, each with its id,
        a revision's bytes ``revision`` with its revision id, and the
        shared drives ``drives``; any other request is named by its method
        and route, with its path."""
        listed = await self.run.call("GET", "/_kit/requests")
        named: list[tuple[str, str]] = []
        for r in listed["requests"]:
            route, path = r["route"], r["path"]
            query = parse_qs(r["query"])
            if r["method"] == "GET" and route == FILES:
                folders = PARENTS.findall(query.get("q", [""])[0])
                named.append(("list", ",".join(folders)))
            elif r["method"] == "GET" and route == FILE:
                media = query.get("alt") == ["media"]
                named.append(
                    ("media" if media else "get", path.rsplit("/")[-1])
                )
            elif r["method"] == "GET" and route == REVISION:
                named.append(("revision", path.rsplit("/")[-1]))
            elif r["method"] == "GET" and route == DRIVES:
                named.append(("drives", ""))
            else:
                named.append((f"{r['method']} {route}", path))
        return named


@pytest_asyncio.fixture
async def google_account(gws_origin: str) -> AsyncIterator[GoogleAccount]:
    """An account of its own on the Google Workspace fake. It lives here,
    not in the root conftest, because an isolated install that runs one
    suite (hermes') has no pytest-asyncio.

    Args:
        gws_origin (str): the fake's origin.
    """
    made = GoogleAccount(gws_origin)
    yield made
    await made.run.close()

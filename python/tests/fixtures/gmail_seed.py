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

from typing import NamedTuple

from tests.fixtures.google_account import (
    MESSAGE,
    MESSAGES,
    UNTIL_CLEARED,
    GoogleAccount,
)


class Mail(NamedTuple):
    """One message of the seeded mailbox, by the key a test names it by."""

    key: str
    labels: tuple[str, ...]
    date: str
    sender: str
    subject: str
    body: str
    attachments: tuple[tuple[str, str, bytes], ...] = ()


# Each a weekday at 09:00 UTC, the Date header Gmail files it by.
JAN_5 = "Mon, 5 Jan 2026 09:00:00 +0000"
JAN_6 = "Tue, 6 Jan 2026 09:00:00 +0000"
JAN_7 = "Wed, 7 Jan 2026 09:00:00 +0000"
JAN_8 = "Thu, 8 Jan 2026 09:00:00 +0000"
PLAN = b"plan\n"

MAILBOX = [
    Mail(
        "a1",
        ("INBOX",),
        JAN_5,
        "Ana Lima <ana@example.com>",
        "Budget review",
        "numbers for travel",
        (("plan.txt", "text/plain", PLAN),),
    ),
    Mail(
        "b2",
        ("INBOX", "Work"),
        JAN_6,
        "Bo <bo@example.com>",
        "Lunch",
        "deploy friday",
    ),
    Mail("c3", ("TRASH",), JAN_6, "Cy <cy@example.com>", "Old", "deploy"),
    Mail("d4", ("INBOX",), JAN_7, "Di <di@example.com>", "Notes", "quiet"),
    Mail(
        "e5",
        ("INBOX",),
        JAN_7,
        "Ed <ed@example.com>",
        "Report",
        "see attached",
        (("report", "application/rtf", PLAN),),
    ),
    Mail(
        "f6",
        ("INBOX",),
        JAN_7,
        "Fa <fa@example.com>",
        "Formats",
        "rtf beats doc",
    ),
    Mail(
        "g7",
        ("INBOX",),
        JAN_8,
        "Gi <gi@example.com>",
        "Trip",
        "the traveler program",
    ),
    Mail(
        "h8",
        ("INBOX",),
        JAN_8,
        "Ha <ha@example.com>",
        "Hike",
        "the mountain trail",
    ),
    Mail(
        "i9",
        ("INBOX",),
        "Thu, 8 Jan 2026 09:00:00 -0700 (Mountain Standard Time)",
        "Io <io@example.com>",
        "Ping",
        "quiet",
    ),
    Mail(
        "j10",
        ("INBOX",),
        JAN_8,
        "Jo <jo@example.com>",
        "Links",
        "notes at example.com/wombat/guide",
    ),
]


async def seed(account: GoogleAccount) -> dict[str, str]:
    """Fill the account's mailbox with ``MAILBOX`` and return each
    message's key by the id the fake gave it.

    Gmail cuts a snippet where it likes; g7's is answered as Gmail may
    give it, cut inside ``traveler``, so ``travel`` is in g7's text only
    there.

    Args:
        account (GoogleAccount): the account.
    """
    await account.reset()
    keys: dict[str, str] = {}
    for mail in MAILBOX:
        made = await account.message(
            mail.subject,
            mail.body,
            labels=mail.labels,
            sender=mail.sender,
            date=mail.date,
            attachments=mail.attachments,
        )
        keys[made] = mail.key
    g7 = next(made for made, key in keys.items() if key == "g7")
    await account.run.answer_next(
        "GET",
        MESSAGE,
        200,
        {**await account.mail(g7), "snippet": "the travel"},
        times=UNTIL_CLEARED,
        path=f"{MESSAGES}/{g7}",
    )
    return keys

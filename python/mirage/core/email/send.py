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

from email.message import EmailMessage
from typing import Any

import aiosmtplib

from mirage.resource.email.config import EmailConfig
from mirage.resource.secrets import reveal_secret


async def _smtp_send(config: EmailConfig, msg: EmailMessage) -> None:
    await aiosmtplib.send(
        msg,
        hostname=config.smtp_host,
        port=config.smtp_port,
        username=config.username,
        password=reveal_secret(config.password),
        start_tls=True,
    )


async def send_message(
    config: EmailConfig,
    to: str,
    subject: str,
    body: str,
) -> dict[str, Any]:
    msg = EmailMessage()
    msg["From"] = config.username
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    await _smtp_send(config, msg)
    return {"status": "sent", "to": to, "subject": subject}


async def reply_message(
    config: EmailConfig,
    original: dict[str, Any],
    body: str,
) -> dict[str, Any]:
    msg = EmailMessage()
    msg["From"] = config.username
    msg["To"] = original["from"]["email"]
    msg["Subject"] = f"Re: {original['subject']}"
    msg["In-Reply-To"] = original["message_id"]
    refs = list(original.get("references", []))
    refs.append(original["message_id"])
    msg["References"] = " ".join(refs)
    msg.set_content(body)
    await _smtp_send(config, msg)
    return {
        "status": "sent",
        "to": original["from"]["email"],
        "subject": msg["Subject"],
    }


async def reply_all_message(
    config: EmailConfig,
    original: dict[str, Any],
    body: str,
) -> dict[str, Any]:
    all_recipients: set[str] = set()
    all_recipients.add(original["from"]["email"])
    for r in original.get("to", []):
        all_recipients.add(r["email"])
    for r in original.get("cc", []):
        all_recipients.add(r["email"])
    all_recipients.discard(config.username)

    msg = EmailMessage()
    msg["From"] = config.username
    msg["To"] = ", ".join(sorted(all_recipients))
    msg["Subject"] = f"Re: {original['subject']}"
    msg["In-Reply-To"] = original["message_id"]
    refs = list(original.get("references", []))
    refs.append(original["message_id"])
    msg["References"] = " ".join(refs)
    msg.set_content(body)
    await _smtp_send(config, msg)
    return {
        "status": "sent",
        "to": sorted(all_recipients),
        "subject": msg["Subject"],
    }


async def forward_message(
    config: EmailConfig,
    original: dict[str, Any],
    to: str,
) -> dict[str, Any]:
    msg = EmailMessage()
    msg["From"] = config.username
    msg["To"] = to
    msg["Subject"] = f"Fwd: {original['subject']}"
    fwd_body = (
        f"---------- Forwarded message ----------\n"
        f"From: {original['from']['name']} <{original['from']['email']}>\n"
        f"Date: {original['date']}\n"
        f"Subject: {original['subject']}\n\n"
        f"{original['body_text']}")
    msg.set_content(fwd_body)
    await _smtp_send(config, msg)
    return {"status": "sent", "to": to, "subject": msg["Subject"]}

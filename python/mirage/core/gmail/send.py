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
from email.mime.text import MIMEText
from typing import Any

from mirage.core.gmail.messages import (_extract_header, get_message_processed,
                                        get_message_raw)
from mirage.core.google._client import (GMAIL_API_BASE, TokenManager,
                                        google_post)


async def send_message(
    token_manager: TokenManager,
    to: str,
    subject: str,
    body: str,
) -> dict[str, Any]:
    """Send a new email.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        to (str): recipient email address.
        subject (str): email subject.
        body (str): plain-text email body.

    Returns:
        dict: API response with sent message metadata.
    """
    msg = MIMEText(body)
    msg["To"] = to
    msg["Subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    url = f"{GMAIL_API_BASE}/users/me/messages/send"
    return await google_post(token_manager, url, {"raw": raw})


async def reply_message(
    token_manager: TokenManager,
    message_id: str,
    body: str,
) -> dict[str, Any]:
    """Reply to a message (preserves threading).

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        message_id (str): ID of the message to reply to.
        body (str): plain-text reply body.

    Returns:
        dict: API response with sent message metadata.
    """
    raw_msg = await get_message_raw(token_manager, message_id)
    headers = raw_msg.get("payload", {}).get("headers", [])
    to = _extract_header(headers, "From")
    subject = _extract_header(headers, "Subject")
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    thread_id = raw_msg.get("threadId", "")
    msg_id_header = _extract_header(headers, "Message-ID")

    mime = MIMEText(body)
    mime["To"] = to
    mime["Subject"] = subject
    if msg_id_header:
        mime["In-Reply-To"] = msg_id_header
        mime["References"] = msg_id_header

    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
    payload: dict[str, Any] = {"raw": raw}
    if thread_id:
        payload["threadId"] = thread_id
    url = f"{GMAIL_API_BASE}/users/me/messages/send"
    return await google_post(token_manager, url, payload)


async def reply_all_message(
    token_manager: TokenManager,
    message_id: str,
    body: str,
) -> dict[str, Any]:
    """Reply-all to a message (preserves threading, includes all recipients).

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        message_id (str): ID of the message to reply to.
        body (str): plain-text reply body.

    Returns:
        dict: API response with sent message metadata.
    """
    raw_msg = await get_message_raw(token_manager, message_id)
    headers = raw_msg.get("payload", {}).get("headers", [])
    sender = _extract_header(headers, "From")
    original_to = _extract_header(headers, "To")
    original_cc = _extract_header(headers, "Cc")
    subject = _extract_header(headers, "Subject")
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    thread_id = raw_msg.get("threadId", "")
    msg_id_header = _extract_header(headers, "Message-ID")

    all_to = ", ".join(filter(None, [sender, original_to]))

    mime = MIMEText(body)
    mime["To"] = all_to
    if original_cc:
        mime["Cc"] = original_cc
    mime["Subject"] = subject
    if msg_id_header:
        mime["In-Reply-To"] = msg_id_header
        mime["References"] = msg_id_header

    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
    payload: dict[str, Any] = {"raw": raw}
    if thread_id:
        payload["threadId"] = thread_id
    url = f"{GMAIL_API_BASE}/users/me/messages/send"
    return await google_post(token_manager, url, payload)


async def forward_message(
    token_manager: TokenManager,
    message_id: str,
    to: str,
) -> dict[str, Any]:
    """Forward a message.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        message_id (str): ID of the message to forward.
        to (str): recipient email address.

    Returns:
        dict: API response with sent message metadata.
    """
    processed = await get_message_processed(token_manager, message_id)
    subject = processed.get("subject", "")
    if not subject.lower().startswith("fwd:"):
        subject = f"Fwd: {subject}"
    fwd_body = (f"---------- Forwarded message ----------\n"
                f"From: {processed['from'].get('email', '')}\n"
                f"Date: {processed.get('date', '')}\n"
                f"Subject: {processed.get('subject', '')}\n\n"
                f"{processed.get('body_text', '')}")
    return await send_message(token_manager, to, subject, fwd_body)

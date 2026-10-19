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

import os
import time

from dotenv import load_dotenv
from langfuse import Langfuse, propagate_attributes

load_dotenv("/Users/zecheng/strukto/mirage/.env.development")

langfuse = Langfuse(
    public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
    secret_key=os.environ["LANGFUSE_SECRET_KEY"],
    host=os.environ["LANGFUSE_HOST"],
)

print("Auth check:", langfuse.auth_check())

print("\n=== Creating prompts ===")

for name, prompt_text, cfg, label in [
    (
        "summarize",
        "Summarize the following text in {{style}} style:\n\n{{text}}",
        {"model": "gpt-4o", "temperature": 0.3},
        "production",
    ),
    (
        "summarize",
        "You are an expert summarizer. Summarize in {{style}} style:\n\n{{text}}",
        {"model": "gpt-4o", "temperature": 0.2},
        "staging",
    ),
    (
        "classify",
        "Classify the sentiment as positive, negative, or neutral:\n\n{{text}}",
        {"model": "gpt-4o-mini", "temperature": 0},
        "production",
    ),
    (
        "extract-entities",
        "Extract all named entities. Return as JSON.\n\n{{text}}",
        {"model": "gpt-4o", "temperature": 0},
        "production",
    ),
]:
    langfuse.create_prompt(
        name=name,
        type="text",
        prompt=prompt_text,
        config=cfg,
        labels=[label],
    )
    print(f"  created: {name} [{label}]")

print("\n=== Creating traces ===")

traces_data = [
    {
        "trace_name": "chat-completion",
        "session_id": "chat-session-001",
        "user_id": "user-alice",
        "tags": ["chat", "geography"],
        "input": {
            "messages": [
                {"role": "user", "content": "What is the capital of France?"}
            ]
        },
        "output": {"response": "The capital of France is Paris."},
        "model": "gpt-4o",
    },
    {
        "trace_name": "chat-completion",
        "session_id": "chat-session-001",
        "user_id": "user-alice",
        "tags": ["chat", "geography"],
        "input": {
            "messages": [
                {"role": "user", "content": "Tell me more about Paris"}
            ]
        },
        "output": {
            "response": "Paris is known for the Eiffel Tower and Louvre Museum."
        },
        "model": "gpt-4o",
    },
    {
        "trace_name": "chat-completion",
        "session_id": "chat-session-002",
        "user_id": "user-bob",
        "tags": ["chat", "science"],
        "input": {
            "messages": [
                {"role": "user", "content": "Explain quantum computing"}
            ]
        },
        "output": {
            "response": "Quantum computing uses qubits that can be in superposition..."
        },
        "model": "gpt-4o",
    },
    {
        "trace_name": "summarize-document",
        "session_id": "chat-session-002",
        "user_id": "user-bob",
        "tags": ["summarization", "science"],
        "input": {"text": "A long research paper about quantum computing..."},
        "output": {
            "summary": "This paper introduces a novel approach to error correction..."
        },
        "model": "gpt-4o",
    },
    {
        "trace_name": "support-classify",
        "session_id": "support-ticket-101",
        "user_id": "user-charlie",
        "tags": ["support", "classification"],
        "input": {"text": "I can't log in, keeps showing error 403"},
        "output": {"category": "authentication", "priority": "high"},
        "model": "gpt-4o-mini",
    },
    {
        "trace_name": "support-respond",
        "session_id": "support-ticket-101",
        "user_id": "user-charlie",
        "tags": ["support", "response"],
        "input": {"ticket": "Can't log in, error 403"},
        "output": {"response": "Please try clearing your browser cookies..."},
        "model": "gpt-4o",
    },
    {
        "trace_name": "entity-extraction",
        "user_id": "user-alice",
        "tags": ["extraction", "ner"],
        "input": {
            "text": "Apple CEO Tim Cook announced new products in Cupertino."
        },
        "output": {
            "entities": [
                {"name": "Apple", "type": "ORG"},
                {"name": "Tim Cook", "type": "PERSON"},
            ]
        },
        "model": "gpt-4o",
    },
    {
        "trace_name": "chat-completion",
        "user_id": "user-dave",
        "tags": ["chat", "creative"],
        "input": {
            "messages": [
                {"role": "user", "content": "Write a haiku about programming"}
            ]
        },
        "output": {
            "response": "Code flows like water\n"
            "Bugs swim in the logic stream\n"
            "Debug, compile, run",
        },
        "model": "gpt-4o",
    },
]

for td in traces_data:
    with propagate_attributes(
        trace_name=td["trace_name"],
        session_id=td.get("session_id"),
        user_id=td.get("user_id"),
        tags=td.get("tags"),
        metadata={"env": "production"},
    ):
        with langfuse.start_as_current_observation(
            name=td["trace_name"],
            as_type="span",
            input=td["input"],
            output=td["output"],
        ):
            with langfuse.start_as_current_observation(
                name=f"{td['trace_name']}-llm",
                as_type="generation",
                model=td["model"],
                input=td["input"],
                output=td["output"],
                usage_details={
                    "input_tokens": 50 + len(str(td["input"])),
                    "output_tokens": 30 + len(str(td["output"])),
                },
            ):
                pass
    print(
        f"  created: {td['trace_name']} (session={td.get('session_id', '-')})"
    )

print(f"\n  total: {len(traces_data)} traces")

print("\n=== Creating datasets ===")

langfuse.create_dataset(name="qa-eval", description="QA evaluation")

qa_items = [
    ({"question": "What is the capital of France?"}, {"answer": "Paris"}),
    ({"question": "Who wrote Romeo and Juliet?"}, {"answer": "Shakespeare"}),
    (
        {"question": "What is the speed of light?"},
        {"answer": "299,792,458 m/s"},
    ),
    ({"question": "What is the largest planet?"}, {"answer": "Jupiter"}),
    ({"question": "Who painted the Mona Lisa?"}, {"answer": "da Vinci"}),
]
for inp, exp in qa_items:
    langfuse.create_dataset_item(
        dataset_name="qa-eval",
        input=inp,
        expected_output=exp,
    )
print(f"  qa-eval: {len(qa_items)} items")

langfuse.create_dataset(
    name="sentiment-eval", description="Sentiment classification"
)

sent_items = [
    ({"text": "I love this product!"}, {"sentiment": "positive"}),
    ({"text": "Terrible experience"}, {"sentiment": "negative"}),
    ({"text": "It was okay"}, {"sentiment": "neutral"}),
    ({"text": "Best purchase ever"}, {"sentiment": "positive"}),
    ({"text": "Completely broken"}, {"sentiment": "negative"}),
]
for inp, exp in sent_items:
    langfuse.create_dataset_item(
        dataset_name="sentiment-eval",
        input=inp,
        expected_output=exp,
    )
print(f"  sentiment-eval: {len(sent_items)} items")

print("\n=== Flushing ===")
langfuse.flush()
time.sleep(3)

print("\n=== Verifying ===")
traces = langfuse.fetch_traces(limit=5)
print(f"  traces: {len(traces.data)} found")
for t in traces.data[:3]:
    print(f"    {t.name} (session={t.session_id})")

prompt = langfuse.get_prompt("summarize")
print(f"  summarize prompt: v{prompt.version}")

print("\nDone!")

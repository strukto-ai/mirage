OSS Server accepts `multipart/form-data` with a JSON `request` part followed by
a `stdin` part. It accepts up to 64 MiB of input and supplies the bytes to the command
as they arrive. Cloud currently accepts JSON shell requests and does not support multipart stdin.

<CodeGroup>
```bash cURL
printf 'b\na\n' | curl '{{BASE_URL}}/v1/workspaces/demo/shell' \
  --header "Authorization: Bearer $MIRAGE_AUTH_TOKEN" \
  --form 'request={"command":"sort"};type=application/json' \
  --form 'stdin=@-'
```

```python Python
import json
import os

import httpx

headers = {"Authorization": f"Bearer {os.environ['MIRAGE_AUTH_TOKEN']}"}
with httpx.Client(base_url="{{BASE_URL}}/v1", headers=headers) as client:
    response = client.post("/workspaces/demo/shell", files={
        "request": (None, json.dumps({"command": "sort"}), "application/json"),
        "stdin": ("stdin", b"b\na\n"),
    })
    response.raise_for_status()
    print(response.json()["stdout"], end="")
```

```typescript TypeScript
const form = new FormData()
form.append('request', new Blob([JSON.stringify({ command: 'sort' })], { type: 'application/json' }))
form.append('stdin', new Blob(['b\na\n']))

const response = await fetch('{{BASE_URL}}/v1/workspaces/demo/shell', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.MIRAGE_AUTH_TOKEN}` },
  body: form,
})
if (!response.ok) throw new Error(`HTTP ${response.status}`)
const result = await response.json()
process.stdout.write(result.stdout)
```

</CodeGroup>

The command sorts the input and returns `a\nb\n` in `stdout`.

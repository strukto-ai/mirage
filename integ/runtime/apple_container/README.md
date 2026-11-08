# apple_container

What only Apple's container has. Needs Apple silicon with macOS 26 or
later; set `MIRAGE_INTEG_APPLE_CONTAINER` to a running container.

| File            | Pins                                 |
| --------------- | ------------------------------------ |
| `streams.json`  | stderr stays separate                |
| `sessions.json` | the session env replaces the image's |
| `cwd.json`      | an unserved cwd fails loud           |

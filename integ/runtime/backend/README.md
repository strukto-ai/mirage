# backend

Guest programs on real services rather than RAM, on monty (and quickjs for
the `_js` cases).

| File           | Pins                                                                            | Needs                       |
| -------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `redis.json`   | guest reads and open modes on a redis mount                                     | `REDIS_URL`                 |
| `s3.json`      | guest reads, cache invalidation and warm reads, `open('w')`, facade probes      | `S3_ENDPOINT` on typescript |
| `mongodb.json` | a guest reads a MongoDB mount                                                   | `MONGODB_URI`               |
| `mounts.json`  | one script over several mounts, a link op limit, a rename across mounts refused | `S3_ENDPOINT` on typescript |

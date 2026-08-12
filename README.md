# boardlink

Connect to climbing-board apps — **Kilter**, **Tension**, and **MoonBoard** — and pull your logbook
as normalized, board-agnostic ascents. One data contract, in both **TypeScript** and **Python**.

None of these boards has an official public API. boardlink implements the same flows their own apps
use, so you can get *your own* climbing data out of them. It's the only library that supports the
**new Kilter app** (the kiltergrips.com backend Kilter moved to after leaving Aurora in 2025).

> A password is used once to obtain a session token and is never stored. Persist only the returned
> token for re-syncs.

## Boards

| Board | Backend | Auth |
| --- | --- | --- |
| Kilter | kiltergrips.com (Keycloak + REST) | OAuth2 + PKCE, refresh token |
| Tension | Aurora (tensionboardapp2.com) | session token |
| MoonBoard | moonboard.com | cookie / CSRF session |

The reverse-engineered new-Kilter API is documented in [docs/kilter-new-api.md](docs/kilter-new-api.md).

## Repo layout

```
packages/
  core/     @boardlink/core    TypeScript SDK
  server/   @boardlink/server  HTTP wrapper + zero-dep Node server + CLI
python/     boardlink          native Python package (PyPI)
tools/                         diagnostics used while building the connectors
```

## The Ascent contract

The same shape in both languages (snake_case in Python):

```ts
interface Ascent {
  board: "kilter" | "tension" | "moonboard";
  climbName: string;
  date: string;        // ISO
  grade?: string;      // e.g. "6C+/V5" or "7A+"
  userGrade?: string;
  vGrade?: number;     // parsed V-scale integer
  tries?: number;      // 1 = flash
  angle?: number;
  isBenchmark?: boolean;
  isMirror?: boolean;
  isRepeat?: boolean;
  comment?: string;
}
```

## TypeScript

```bash
pnpm install
pnpm build
pnpm test
```

```ts
import { connectKilter, BoardError } from "@boardlink/core";

try {
  const { token, ascents } = await connectKilter({ username, password });
  // store `token` (a refresh token); re-sync later with connectKilter({ token })
} catch (e) {
  if (e instanceof BoardError && e.code === "bad-credentials") { /* ... */ }
}
```

Run it as an HTTP service, or embed the handler in an existing framework:

```bash
pnpm --filter @boardlink/server build
PORT=8787 node packages/server/dist/cli.js   # POST /kilter | /tension | /moonboard
```

```ts
import { handleBoardRequest } from "@boardlink/server";
const { status, body } = await handleBoardRequest("kilter", await req.json());
```

## Python

```bash
cd python
pip install -e ".[dev]"
pytest
```

```python
from boardlink import connect_kilter

result = connect_kilter("you@example.com", "password")
for a in result.ascents:
    print(a.date, a.grade, a.v_grade)
```

## Responsible use

boardlink exists for interoperability — getting your own data out of an app you have an account with.
Please keep it that way:

- Use it with your own account and your own data.
- Don't scrape other users' data or republish a board's proprietary climb database.
- Be gentle: cache results and don't hammer the servers — a logbook sync is a single request per
  board, so there's no need to poll it in a loop.
- Automated access may be against a board's terms of service; that's on you to check.

## License

MIT

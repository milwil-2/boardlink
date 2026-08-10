# boardlink

Connect to climbing-board apps — **Kilter**, **Tension**, and **MoonBoard** — and pull a user's
logbook as normalized, board-agnostic ascents. One data contract, available in both **TypeScript**
and **Python**, so you can drop it into any future project.

None of these boards has an official public API. boardlink wraps the reverse-engineered endpoints
(TypeScript) / the community [`boardlib`](https://github.com/lemeryfertitta/BoardLib) package
(Python) and normalizes everything into a single `Ascent` shape.

> ⚠️ **Security:** a password is used **once** to obtain a session token and is never stored. Persist
> only the returned token for re-syncs. Never log or save the raw password.

## Repo layout

```
boardlink/
├── packages/
│   ├── core/     @boardlink/core   — TS SDK: connectKilter / connectTension / connectMoonboard
│   └── server/   @boardlink/server — thin HTTP wrapper + zero-dep Node server + CLI
├── python/       boardlink (PyPI)  — connect_kilter / connect_tension / connect_moonboard
└── tools/
    └── board_probe.mjs — safe, redacting live-API diagnostic (see "Verifying live" below)
```

## The data contract (`Ascent`)

Identical in TS and Python (snake_case in Python):

```ts
interface Ascent {
  board: "kilter" | "tension" | "moonboard";
  climbName: string;
  date: string;        // ISO
  grade?: string;      // displayed, e.g. "6C+/V5" or "7A+"
  userGrade?: string;
  vGrade?: number;     // parsed V-scale integer
  tries?: number;      // 1 = flash
  angle?: number;      // MoonBoard fixed 40
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
  // store `token`; re-sync later with connectKilter({ token })
} catch (e) {
  if (e instanceof BoardError && e.code === "bad-credentials") { /* ... */ }
}
```

### As an HTTP service

```bash
pnpm --filter @boardlink/server build
PORT=8787 node packages/server/dist/cli.js
# POST http://localhost:8787/kilter  { "username": "...", "password": "..." }
```

Or embed the framework-agnostic handler in Next.js / Express / Hono:

```ts
import { handleBoardRequest } from "@boardlink/server";
const { status, body } = await handleBoardRequest("moonboard", await req.json());
```

## Python

```bash
cd python
pip install -e ".[dev]"
pytest
```

```python
from boardlink import connect_kilter, BoardError

try:
    result = connect_kilter(username, password)
    for ascent in result.ascents:
        print(ascent.date, ascent.grade, ascent.v_grade)
except BoardError as e:
    print(e.code, e)
```

## Verifying live

The connectors' request/response *mapping* is unit-tested, but the live login handshakes can only be
verified against a real account. `tools/board_probe.mjs` hits the real endpoints and prints only
redacted, structural info (no secrets, names, or comments):

```bash
BOARD_USER='you@example.com' BOARD_PASS='...' node tools/board_probe.mjs kilter
```

See the file header for details on what it redacts.

## License

MIT

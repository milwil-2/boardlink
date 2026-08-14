# @boardlink/core

Connect to climbing-board apps — **Kilter**, **Tension**, and **MoonBoard** — and pull your logbook
as normalized, board-agnostic ascents. TypeScript SDK; a native Python package is also available as
[`boardlink`](https://github.com/milwil-2/boardlink).

None of these boards has an official public API. `@boardlink/core` implements the same flows their
own apps use, so you can get *your own* climbing data out of them — including the **new Kilter app**.

```bash
npm install @boardlink/core
```

```ts
import { connectKilter, BoardError } from "@boardlink/core";

try {
  const { token, ascents } = await connectKilter({ username, password });
  // store `token` (a refresh token); re-sync later with connectKilter({ token })
  for (const a of ascents) console.log(a.date, a.grade, a.vGrade);
} catch (e) {
  if (e instanceof BoardError && e.code === "bad-credentials") { /* ... */ }
}
```

> A password is used once to obtain a session token and is never stored. Persist only the returned
> token for re-syncs.

Full docs, the `Ascent` contract, and per-board notes live in the
[repository README](https://github.com/milwil-2/boardlink#readme).

## License

MIT

# @boardlink/server

A thin, zero-dependency HTTP wrapper over [`@boardlink/core`](https://www.npmjs.com/package/@boardlink/core):
`POST /:board` returns a normalized logbook. Run it as a standalone Node server or embed the handler
in an existing framework.

```bash
npm install @boardlink/server
```

Standalone server (also exposes a `boardlink-server` bin):

```bash
PORT=8787 npx boardlink-server   # POST /kilter | /tension | /moonboard
```

Embed the handler:

```ts
import { handleBoardRequest } from "@boardlink/server";
const { status, body } = await handleBoardRequest("kilter", await req.json());
```

## Deploying safely

This endpoint proxies **real board credentials**, and each success response carries a session
`token` that is equivalent to a long-lived login. Treat the server as a credential custodian:

- **Never run it auth-less in public.** An open `POST /:board` is a credential-testing proxy for
  anyone on the internet. Pass an `auth` predicate (checks a header/mTLS/allowlist; runs before the
  body is read) and a `rateLimit` (fixed window, keyed on the socket address):

  ```ts
  import { createBoardServer } from "@boardlink/server";
  createBoardServer({
    auth: (req) => req.headers["x-api-key"] === process.env.API_KEY,
    rateLimit: { windowMs: 60_000, max: 30 },
    cors: true,
  }).listen(8787);
  ```

  `rateLimit` keys on `req.socket.remoteAddress` (not the spoofable `x-forwarded-for`). Behind a
  proxy, rate-limit at the proxy or embed `handleBoardRequest` in your own framework.
- **Put TLS in front.** Terminate TLS at a reverse proxy; never send credentials or tokens over
  plaintext HTTP.
- **`raw` is stripped by default.** Backend records can carry unaudited fields (UUIDs, gym/location
  data). Responses omit each ascent's `raw` unless you opt in with `includeRaw: true`.
- **The token is sensitive.** The success response is sent with `Cache-Control: no-store`. Keep the
  token server-side, encrypted at rest — never in logs, error reports, `localStorage`, or
  JS-readable cookies. This library never logs it.

See [`docs/security.md`](https://github.com/milwil-2/boardlink/blob/main/docs/security.md) for the
full threat model (including prompt-injection via untrusted free-text fields).

Full docs live in the [repository README](https://github.com/milwil-2/boardlink#readme).

## License

MIT

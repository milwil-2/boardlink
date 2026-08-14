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

Full docs live in the [repository README](https://github.com/milwil-2/boardlink#readme).

## License

MIT

#!/usr/bin/env node
import { createBoardServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const cors = process.env.CORS !== "false";

createBoardServer({ cors }).listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`boardlink server listening on http://localhost:${port}  (POST /kilter | /tension | /moonboard)`);
});

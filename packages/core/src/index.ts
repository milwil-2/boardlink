import type { BoardAuth, BoardSystem, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { connectAurora } from "./aurora.js";
import { connectMoonboard } from "./moon.js";

export * from "./types.js";
export * from "./grades.js";
export * from "./http.js";
export * from "./aurora.js";
export * from "./moon.js";

/** Connect to Kilter and pull the normalized logbook. */
export const connectKilter = (auth: BoardAuth, opts?: ConnectOptions): Promise<ConnectResult> =>
  connectAurora("kilter", auth, opts);

/** Connect to Tension and pull the normalized logbook. */
export const connectTension = (auth: BoardAuth, opts?: ConnectOptions): Promise<ConnectResult> =>
  connectAurora("tension", auth, opts);

export { connectMoonboard, connectAurora };

/** Dispatch to the right connector by board name. */
export function connectBoard(
  board: BoardSystem,
  auth: BoardAuth,
  opts?: ConnectOptions,
): Promise<ConnectResult> {
  switch (board) {
    case "kilter":
    case "tension":
      return connectAurora(board, auth, opts);
    case "moonboard":
      return connectMoonboard(auth, opts);
    default:
      throw new BoardError("unexpected-response", `unknown board: ${board as string}`);
  }
}

import type { BoardAuth, BoardSystem, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { connectAurora } from "./aurora.js";
import { connectKilter } from "./kilter.js";
import { connectMoonboard } from "./moon.js";

export * from "./types.js";
export * from "./grades.js";
export * from "./http.js";
export * from "./aurora.js";
export * from "./kilter.js";
export * from "./moon.js";

/** Connect to Tension (still on the Aurora backend) and pull the normalized logbook. */
export const connectTension = (auth: BoardAuth, opts?: ConnectOptions): Promise<ConnectResult> =>
  connectAurora("tension", auth, opts);

export { connectKilter, connectMoonboard, connectAurora };

/**
 * Dispatch to the right connector by board name. Note: Kilter uses the new kiltergrips.com backend
 * (it left Aurora in 2025); Tension is still Aurora; MoonBoard is independent.
 */
export function connectBoard(
  board: BoardSystem,
  auth: BoardAuth,
  opts?: ConnectOptions,
): Promise<ConnectResult> {
  switch (board) {
    case "kilter":
      return connectKilter(auth, opts);
    case "tension":
      return connectAurora("tension", auth, opts);
    case "moonboard":
      return connectMoonboard(auth, opts);
    default:
      throw new BoardError("unexpected-response", `unknown board: ${board as string}`);
  }
}

import type { BoardAuth, BoardSystem, ConnectOptions, ConnectResult } from "./types.js";
import { BoardError } from "./types.js";
import { connectAurora } from "./aurora.js";
import { connectKilter } from "./kilter.js";

export * from "./types.js";
export * from "./grades.js";
export * from "./http.js";
export * from "./aurora.js";
export * from "./kilter.js";
// MoonBoard support is temporarily removed (its API was retired); see
// https://github.com/milwil-2/boardlink/issues/1. Its pure mappers are intentionally NOT re-exported
// here to keep them off the public surface while the connector is out.
export * from "./cache.js";
export * from "./db.js";
export * from "./webnames.js";
export * from "./safety.js";

/** Connect to Tension (still on the Aurora backend) and pull the normalized logbook. */
export const connectTension = (auth: BoardAuth, opts?: ConnectOptions): Promise<ConnectResult> =>
  connectAurora("tension", auth, opts);

export { connectKilter, connectAurora };

/**
 * Dispatch to the right connector by board name. Note: Kilter uses the new kiltergrips.com backend
 * (it left Aurora in 2025); Tension is still Aurora. MoonBoard is temporarily unsupported (its API
 * was retired) and rejects with a `retired` BoardError — see
 * https://github.com/milwil-2/boardlink/issues/1.
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
      throw new BoardError(
        "retired",
        "MoonBoard support is temporarily unavailable: its web API was decommissioned and the new " +
          "app backend is gated by Apple App Attest. Track re-enablement at " +
          "https://github.com/milwil-2/boardlink/issues/1",
        "moonboard",
      );
    default:
      throw new BoardError("unexpected-response", `unknown board: ${board as string}`);
  }
}

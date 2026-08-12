/** The climbing-board systems boardlink can connect to. */
export type BoardSystem = "kilter" | "tension" | "moonboard";

/** A user's login for a board account. Used once to obtain a session token. */
export interface Credentials {
  username: string;
  password: string;
}

/**
 * An opaque session credential returned by a connect call, used to re-sync without the password.
 * For Aurora boards (Kilter/Tension) this is the bearer token; for MoonBoard it's a serialized
 * cookie jar. Treat it as opaque and store it securely — never store the raw password.
 */
export type SessionToken = string;

/** Either fresh credentials or a previously-issued session token. */
export type BoardAuth = Credentials | { token: SessionToken };

/**
 * One normalized ascent — board-agnostic. This is boardlink's public data contract; the Python
 * package emits the same shape. Consumers map this to their own domain types.
 */
export interface Ascent {
  board: BoardSystem;
  /** Problem/climb name. Empty only when the board doesn't return it (e.g. Aurora's Tension logs). */
  climbName: string;
  /** ISO date or datetime the climb was logged. */
  date: string;
  /** Grade as displayed by the board, e.g. "6C+/V5" or "7A+". */
  grade?: string;
  /** Grade the user personally logged it at, when it differs from the consensus grade. */
  userGrade?: string;
  /** Parsed V-scale integer derived from {@link grade}, when derivable. */
  vGrade?: number;
  /** Attempts on this ascent (1 = flash). */
  tries?: number;
  /** Wall angle in degrees (Kilter/Tension adjustable; MoonBoard fixed at 40). */
  angle?: number;
  isBenchmark?: boolean;
  isMirror?: boolean;
  isRepeat?: boolean;
  comment?: string;
  /**
   * The untouched source record this ascent was mapped from. Escape hatch for board-specific fields
   * the normalized shape doesn't cover (e.g. Kilter's gymUuid/wallUuid/topped). Present unless a
   * board synthesizes ascents from more than one source row.
   */
  raw?: Record<string, unknown>;
}

/** The result of a successful connect/sync: a re-usable token plus the normalized logbook. */
export interface ConnectResult {
  board: BoardSystem;
  token: SessionToken;
  ascents: Ascent[];
}

/** Optional knobs for a connect call. */
export interface ConnectOptions {
  /** Inject a fetch implementation (for tests, proxies, or non-global-fetch runtimes). */
  fetch?: typeof fetch;
  /** Override the User-Agent header (MoonBoard is picky about it). */
  userAgent?: string;
}

/** A known, user-actionable failure category. */
export type BoardErrorCode =
  | "missing-credentials"
  | "bad-credentials"
  | "session-expired"
  | "unreachable"
  | "unexpected-response";

/** Typed error for all board failures, so callers can branch on {@link code} not string matching. */
export class BoardError extends Error {
  readonly code: BoardErrorCode;
  readonly board?: BoardSystem;
  constructor(code: BoardErrorCode, message: string, board?: BoardSystem) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.board = board;
  }
}

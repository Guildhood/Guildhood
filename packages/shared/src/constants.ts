/** Fixed simulation rate shared by the authoritative server and client prediction. */
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** The server broadcasts a snapshot every N ticks (15 Hz at a 30 Hz tick). */
export const SNAPSHOT_EVERY = 2;

/** Remote cars are rendered this far in the past so there are always two snapshots to blend. */
export const INTERPOLATION_DELAY_MS = 110;

/** A dropped player's car is held (and shown as disconnected) for this long before the seat is freed. */
export const RECONNECT_GRACE_MS = 20_000;

/** Inputs buffered per player beyond this are discarded oldest-first; at most one runs per tick. */
export const MAX_INPUT_QUEUE = 6;

/** An instance with nobody in it (connected or in grace) is closed after this long. */
export const EMPTY_INSTANCE_TTL_MS = 30_000;

/** How often the game server reports its instances to the database registry. */
export const HEARTBEAT_MS = 10_000;

/** Messages larger than this are rejected before parsing. */
export const MAX_MESSAGE_BYTES = 8_192;

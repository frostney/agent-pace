// How much a measured burn has to rest on before agent-pace counts it.

/** Both providers report usage in whole points, so a reading can be up to a point off. */
export const USE_STEP = 1;
/** The most a recent rate may be off by, as a share of it, to count. */
export const EVIDENCE_ERROR = 1 / 3;
/** A move this large keeps a point's error within that share. */
export const EVIDENCE_POINTS = USE_STEP / EVIDENCE_ERROR;

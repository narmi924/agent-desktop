'use strict';

/**
 * The time limit a wait helper got: a number of milliseconds, or an options object with `timeout`, which a script or
 * a `job retry --options` may give in the same place. Anything that is not a finite number falls back to the default,
 * so a wait can never run without an end.
 */
function waitArgs(limit, options = {}, fallback) {
  const given = limit && typeof limit === 'object' && !Array.isArray(limit) ? limit : { timeout: limit };
  const merged = { ...given, ...options };
  const ms = Number(merged.timeout);
  return { timeout: merged.timeout !== undefined && Number.isFinite(ms) && ms >= 0 ? ms : fallback, options: merged };
}

module.exports = { waitArgs };

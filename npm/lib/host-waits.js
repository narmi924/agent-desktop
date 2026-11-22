'use strict';

/** How long a failed step in a job waits for a fix before the job fails with that step's error. */
const FIX_WAIT_MS = 10 * 60 * 1000;

/**
 * How long a job waits before a final step for the user to agree in the chat. Longer than a fix: the user may have
 * stepped away and come back after a notification. With no answer the step is not sent and the job ends.
 */
const APPROVAL_WAIT_MS = 30 * 60 * 1000;

module.exports = { FIX_WAIT_MS, APPROVAL_WAIT_MS };

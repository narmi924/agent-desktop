'use strict';

const { constants } = require('node:os');

/**
 * The code a failed command reports. Every failure gets one: a code the error carries, FILE_NOT_FOUND for a file that
 * is not there, INVALID_ARGS for options Node could not parse, SCRIPT_ERROR for a script that threw outside any step,
 * and ACTION_FAILED for a step or command that could not do its work and said why only in words.
 */
function errorCode(err) {
  const code = typeof err?.code === 'string' ? err.code : undefined;
  if (code === 'ENOENT' || code === 'EISDIR') return 'FILE_NOT_FOUND';
  if (code?.startsWith('ERR_PARSE_ARGS')) return 'INVALID_ARGS';
  if (code && /^[A-Z][A-Z_]*$/.test(code) && !Object.hasOwn(constants.errno, code)) return code;
  if (err?.report && !err.report.step && !err.step) return 'SCRIPT_ERROR';
  return 'ACTION_FAILED';
}

module.exports = { errorCode };

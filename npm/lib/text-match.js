'use strict';

/**
 * The fewest single-character edits that turn `wanted` into some stretch of `line`. Text read from a picture gets a
 * character wrong or split now and then, and always in one place, so a short phrase is allowed one or two edits.
 */
function editsWithin(wanted, line) {
  const a = [...wanted.replace(/\s+/g, '')], b = [...line.replace(/\s+/g, '')];
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return Math.min(...previous);
}

module.exports = { editsWithin };

'use strict';

const NAME = /^[A-Za-z_一-鿿][\w一-鿿]*$/u;

/** The parameter names a script reads as `args.name` or `args["name"]`. */
function argNames(source) {
  const names = new Set();
  for (const m of String(source).matchAll(/\bargs\s*\.\s*([A-Za-z_一-鿿][\w一-鿿]*)/gu)) names.add(m[1]);
  for (const m of String(source).matchAll(/\bargs\s*\[\s*(['"`])([^'"`]+)\1\s*\]/g)) names.add(m[2]);
  return [...names];
}

/**
 * Parses --args JSON (or the text of --args-file) into a plain object of named values.
 * Values stay as given; a name must be a plain identifier so it can appear as `{name}` in a saved routine.
 */
function parseArgs(text) {
  if (text === undefined || text === '') return {};
  let value;
  try { value = JSON.parse(text); } catch (err) {
    throw Object.assign(new Error('--args takes a JSON object, for example {"name": "古丽"}: ' + err.message), { code: 'INVALID_ARGS' });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('--args takes a JSON object of named values.'), { code: 'INVALID_ARGS' });
  }
  for (const key of Object.keys(value)) {
    if (!NAME.test(key)) throw Object.assign(new Error('Argument name "' + key + '" must be letters, digits and _.'), { code: 'INVALID_ARGS' });
  }
  return value;
}

/** Refuses a script that reads an argument nobody gave, before any step runs. */
function missingArgs(source, given) {
  return argNames(source).filter(name => !Object.hasOwn(given, name));
}

/** The `args` object a script sees: reading a name that was not given stops the script and names what it needs. */
function argsView(given, needed = []) {
  return new Proxy(Object.freeze({ ...given }), {
    get(target, key) {
      if (typeof key !== 'string' || Object.hasOwn(target, key) || key === 'then' || key === 'toJSON') return target[key];
      const all = [...new Set([...needed, key])].sort();
      throw Object.assign(new Error('The script reads args.' + key + ', which was not given. It needs: ' + all.join(', ') + '.'), { code: 'MISSING_ARGS', details: { needs: all } });
    },
  });
}

module.exports = { argNames, parseArgs, missingArgs, argsView };

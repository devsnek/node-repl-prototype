'use strict';

const IO = require('./io');
const highlight = require('./highlight');
const { Runtime } = require('./inspector');
const { strEscape } = require('./util');
const util = require('util');
const vm = require('vm');

const simpleExpressionRE = /(?:[a-zA-Z_$](?:\w|\$)*\.)*[a-zA-Z_$](?:\w|\$)*[.[]?$/;
const inspect = (v) => util.inspect(v, { colors: true, depth: 2 });

// TODO: use Runtime.evaluate
const evil = (expression) =>
  new vm.Script(expression, {
    filename: 'repl',
  }).runInThisContext({
    displayErrors: true,
    breakOnSigint: true,
  });

async function collectGlobalNames() {
  const keys = Object.getOwnPropertyNames(global);
  try {
    keys.unshift(...await Runtime.globalLexicalScopeNames().names);
  } catch (e) {} // eslint-disable-line no-empty
  return keys;
}

class REPL {
  constructor(stdout, stdin) {
    this.io = new IO(
      stdout, stdin,
      this.onLine.bind(this),
      this.onAutocomplete.bind(this),
      (s) => highlight(s),
      `Node.js ${process.version} (V8 ${process.versions.v8})`,
    );

    this.io.setPrefix('> ');
  }

  eval(code) {
    const wrap = /^\s*\{.*?\}\s*$/.test(code);
    try {
      return evil(wrap ? `(${code})` : code);
    } catch (err) {
      if (wrap && err instanceof SyntaxError) {
        return evil(code);
      }
      throw err;
    }
  }

  async onLine(line) {
    try {
      global.REPL.last = this.eval(line);
      return inspect(global.REPL.last);
    } catch (err) {
      global.REPL.lastError = err;
      return inspect(err);
    }
  }

  async onAutocomplete(buffer) {
    try {
      let filter;
      let keys;
      let computed = false;
      if (/\w|[.[]|\$/.test(buffer)) {
        let expr;
        const match = simpleExpressionRE.exec(buffer);
        if (buffer.length === 0) {
          filter = '';
          expr = '';
        } else if (buffer[buffer.length - 1] === '.') {
          filter = '';
          expr = match[0].slice(0, match[0].length - 1);
        } else if (buffer[buffer.length - 1] === '[') {
          filter = '';
          computed = true;
          expr = match[0].slice(0, match[0].length - 1);
        } else {
          const bits = match[0].split('.');
          filter = bits.pop();
          expr = bits.join('.');
        }

        if (expr === '') {
          keys = await collectGlobalNames();
        } else {
          // TODO: figure out throwOnSideEffect
          const k = (await Runtime.evaluate({
            expression: `Object.keys(Object.getOwnPropertyDescriptors(${expr}))`,
            // throwOnSideEffect: true,
            generatePreview: true,
          })).result.preview.properties;

          if (computed) {
            keys = k.map(({ value }) => `${strEscape(value)}]`);
          } else {
            keys = k
              .filter(({ value }) => !/[\x00-\x1f\x27\x5c ]/.test(value)) // eslint-disable-line no-control-regex
              .map(({ value }) => value);
          }
        }
      } else if (buffer.length === 0) {
        keys = await collectGlobalNames();
      }

      if (keys) {
        if (filter) {
          return keys
            .filter((k) => k.startsWith(filter))
            .map((k) => k.slice(filter.length));
        }
        return keys;
      }
    } catch (e) {} // eslint-disable-line no-empty
    return undefined;
  }
}

module.exports = REPL;

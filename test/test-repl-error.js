'use strict';

const assert = require('assert');
const REPL = require('../src/repl');
const { Duplex } = require('stream');

global.require = require;
global.module = module;
global.REPL = {
  time: (fn) => {
  },
  last: undefined,
  lastError: undefined,
};

let output = '';
const inoutStream = new Duplex({
  write(chunk, encoding, callback) {
    output += chunk;
    callback();
  },

  read() {
    this.push("var b = 'invalid\n");
    this.push(null);
  },
});

new REPL(inoutStream, inoutStream);

// Matching only on a minimal piece of the error message because V8 throws
// the error `SyntaxError: Invalid or unexpected token`, where as
// ChakraCore throws the error `SyntaxError: Unterminated string constant`.
const errorMessage = 'SyntaxError:';
process.on('exit', () => {
  assert.ok(output.includes(errorMessage),'should throw syntax error');
});

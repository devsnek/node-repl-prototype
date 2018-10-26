#!/usr/bin/env node
'use strict';

const Module = require('module');
const util = require('util');
const { parse_dammit: parseDammit } = require('acorn/dist/acorn_loose');
const acorn = require('acorn');
const IO = require('./io');
const highlight = require('./highlight');
const { processTopLevelAwait } = require('./await');
const { Runtime, mainContextIdPromise } = require('./inspector');
const { strEscape, isIdentifier } = require('./util');
const isRecoverableError = require('./recoverable');
const NativeFunctions = require('./NativeFunctions');

const builtinLibs = Module.builtinModules.filter((x) => !/^_|\//.test(x));

// TODO(devsnek): make more robust
Error.prepareStackTrace = (err, frames) => {
  const cut = frames.findIndex((f) =>
    !f.getFileName() && !f.getFunctionName()) + 1;

  frames = frames.slice(0, cut);

  if (frames.length === 0) {
    return `${err}`;
  }

  return `${err}\n    at ${frames.join('\n    at ')}`;
};

const inspect = (v) => util.inspect(v, { colors: true, showProxy: 2 });

// https://cs.chromium.org/chromium/src/third_party/blink/renderer/devtools/front_end/sdk/RuntimeModel.js?l=60-78&rcl=faa083eea5586885cc907ae28928dd766e47b6fa
function wrapObjectLiteralExpressionIfNeeded(code) {
  // Only parenthesize what appears to be an object literal.
  if (!(/^\s*\{/.test(code) && /\}\s*$/.test(code))) {
    return code;
  }

  const parse = (async () => 0).constructor;
  try {
    // Check if the code can be interpreted as an expression.
    parse(`return ${code};`);

    // No syntax error! Does it work parenthesized?
    const wrappedCode = `(${code})`;
    parse(wrappedCode);

    return wrappedCode;
  } catch (e) {
    return code;
  }
}

async function collectGlobalNames() {
  const keys = Object.getOwnPropertyNames(global);
  try {
    keys.unshift(...(await Runtime.globalLexicalScopeNames()).names);
  } catch (e) {} // eslint-disable-line no-empty
  return keys;
}

const functionCompletionCache = new Map();

async function performEval(code, awaitPromise = false, bestEffort = false) {
  const expression = wrapObjectLiteralExpressionIfNeeded(code);
  return Runtime.evaluate({
    expression,
    generatePreview: true,
    awaitPromise,
    silent: bestEffort,
    throwOnSideEffect: bestEffort,
    timeout: bestEffort ? 500 : undefined,
    executionContextId: await mainContextIdPromise,
  });
}

async function callFunctionOn(func, remoteObject) {
  return Runtime.callFunctionOn({
    functionDeclaration: func.toString(),
    arguments: [remoteObject],
    executionContextId: await mainContextIdPromise,
  });
}

async function onLine(line) {
  let awaited = false;
  if (line.includes('await')) {
    const processed = processTopLevelAwait(line);
    if (processed !== null) {
      line = processed;
      awaited = true;
    }
  }

  const evaluateResult = await performEval(line, awaited);

  if (evaluateResult.exceptionDetails) {
    const expression = wrapObjectLiteralExpressionIfNeeded(line);
    if (isRecoverableError(expression)) {
      return IO.kNeedsAnotherLine;
    }

    await callFunctionOn(
      (err) => {
        global.REPL.lastError = err;
      },
      evaluateResult.exceptionDetails.exception,
    );

    return inspect(global.REPL.lastError);
  }

  await callFunctionOn(
    (result) => {
      global.REPL.last = result;
    },
    evaluateResult.result,
  );
  return inspect(global.REPL.last);
}

async function oneLineEval(source) {
  const { result, exceptionDetails } =
    await performEval(wrapObjectLiteralExpressionIfNeeded(source), false, true);
  if (exceptionDetails) {
    return undefined;
  }

  if (result.objectId) {
    await Runtime.callFunctionOn({
      functionDeclaration: `${(v) => {
        global.REPL._inspectTarget = v;
      }}`,
      arguments: [result],
      executionContextId: await mainContextIdPromise,
    });
    const s = util.inspect(global.REPL._inspectTarget, {
      breakLength: Infinity,
      compact: true,
      maxArrayLength: 10,
      depth: 1,
    }).trim();
    return ` // ${s}`;
  }
  return ` // ${util.inspect(result.value)}`;
}

async function onAutocomplete(buffer) {
  if (buffer.length === 0) {
    return collectGlobalNames();
  }

  const statement = parseDammit(buffer).body[0];
  if (statement.type !== 'ExpressionStatement') {
    return undefined;
  }
  const { expression } = statement;

  let keys;
  let filter;
  if (expression.type === 'Identifier') {
    keys = await collectGlobalNames();
    filter = expression.name;

    if (keys.includes(filter)) {
      return oneLineEval(buffer);
    }
  }

  if (expression.type === 'CallExpression' && !buffer.trim().endsWith(')')) {
    // try to autocomplete require and fs methods
    const callee = buffer.slice(expression.callee.start, expression.callee.end);
    const evaluateResult = await performEval(callee, false, true);
    if (!evaluateResult.exceptionDetails) {
      const { description, objectId } = evaluateResult.result;
      const hit = functionCompletionCache.get(objectId);
      const finishParams = (params) => {
        if (expression.arguments.length === params.length) {
          return undefined;
        }
        params = params.slice(expression.arguments.length).join(', ');
        if (expression.arguments.length > 0) {
          if (buffer.trim().endsWith(',')) {
            const spaces = buffer.length - (buffer.lastIndexOf(',') + 1);
            if (spaces > 0) {
              return params;
            }
            return ` ${params}`;
          }
          return `, ${params}`;
        }
        return params;
      };
      if (hit !== undefined) {
        const c = finishParams(hit);
        if (c !== undefined) {
          return c;
        }
      }
      if (description.includes('[native code]')) {
        const { name } = parseDammit(evaluateResult.result.description).body[0].id;
        const entry = NativeFunctions.globalThis[name];
        if (entry) {
          functionCompletionCache.set(objectId, entry[0]);
        }
        const c = finishParams(entry[0]);
        if (c !== undefined) {
          return c;
        }
      } else if (description.length < 10000) {
        let parsed = null;
        try {
          // Try to parse as a function, anonymous function, or arrow function.
          parsed = acorn.parse(`(${description})`, { ecmaVersion: 2019 });
        } catch {} // eslint-disable-line no-empty
        if (!parsed) {
          try {
            // Try to parse as a method.
            parsed = acorn.parse(`({${description}})`, { ecmaVersion: 2019 });
          } catch {} // eslint-disable-line no-empty
        }
        if (parsed && parsed.body && parsed.body[0] && parsed.body[0].expression) {
          const expr = parsed.body[0].expression;
          let params;
          switch (expr.type) {
            case 'ClassExpression': {
              if (!expr.body.body) {
                break;
              }
              const constructor = expr.body.body.find((method) => method.kind === 'constructor');
              if (constructor) {
                ({ params } = constructor.value);
              }
              break;
            }
            case 'ObjectExpression':
              if (!expr.properties[0] || !expr.properties[0].value) {
                break;
              }
              ({ params } = expr.properties[0].value);
              break;
            case 'FunctionExpression':
            case 'ArrowFunctionExpression':
              ({ params } = expr);
              break;
            default:
              break;
          }
          if (params) {
            params = params.map(function paramName(param) {
              switch (param.type) {
                case 'Identifier':
                  return param.name;
                case 'AssignmentPattern':
                  return `?${paramName(param.left)}`;
                case 'ObjectPattern': {
                  const list = param.properties.map((p) => paramName(p.value)).join(', ');
                  return `{ ${list} }`;
                }
                case 'ArrayPattern': {
                  const list = param.elements.map(paramName).join(', ');
                  return `[ ${list} ]`;
                }
                case 'RestElement':
                  return `...${paramName(param.argument)}`;
                default:
                  return '?';
              }
            });
            functionCompletionCache.set(objectId, params);
            const c = finishParams(params);
            if (c !== undefined) {
              return c;
            }
          }
        }
      } else if (expression.callee.type === 'MemberExpression') {
        const receiverSrc = buffer.slice(
          expression.callee.object.start,
          expression.callee.object.end,
        );
        const { result, exceptionDetails } = await performEval(receiverSrc, false, true);
        if (!exceptionDetails) {
          const receiver = result.type === 'function' ?
            parseDammit(result.description).body[0].id.name :
            result.className;
          const { name } = parseDammit(evaluateResult.result.description).body[0].id;
          const entry = NativeFunctions[receiver][name];
          if (entry) {
            functionCompletionCache.set(result.objectId, entry[0]);
          }
          const c = finishParams(entry[0]);
          if (c !== undefined) {
            return c;
          }
        }
      }
    }
  } else if (expression.type === 'MemberExpression') {
    const expr = buffer.slice(expression.object.start, expression.object.end);
    let leadingQuote = false;
    if (expression.computed && expression.property.type === 'Literal') {
      filter = expression.property.value;
      leadingQuote = expression.property.raw.startsWith('\'');
    } else if (!expression.computed && expression.property.type === 'Identifier') {
      filter = expression.property.name === '✖' ? undefined : expression.property.name;
    }

    let evaluateResult = await performEval(expr, false, true);
    if (evaluateResult.exceptionDetails) {
      return undefined;
    }

    if (evaluateResult.result.type !== 'object' &&
        evaluateResult.result.type !== 'undefined' &&
        evaluateResult.result.subtype !== 'null') {
      evaluateResult = await performEval(
        `Object(${wrapObjectLiteralExpressionIfNeeded(expr)})`, false, true,
      );
      if (evaluateResult.exceptionDetails) {
        return undefined;
      }
    }

    const own = [];
    const inherited = [];
    (await Runtime.getProperties({
      objectId: evaluateResult.result.objectId,
      generatePreview: true,
    }))
      .result
      .filter(({ symbol }) => !symbol)
      .forEach(({ isOwn, name }) => {
        if (isOwn) {
          own.push(name);
        } else {
          inherited.push(name);
        }
      });

    keys = [...own, ...inherited];

    if (keys.includes(filter)) {
      return oneLineEval(buffer);
    }

    if (expression.computed) {
      keys = keys.map((key) => {
        let r;
        if (!leadingQuote && `${+key}` === key) {
          r = key;
        } else {
          r = strEscape(key);
          if (leadingQuote) {
            r = r.slice(1);
          }
        }
        return `${r}]`;
      });
    } else {
      keys = keys.filter(isIdentifier);
    }
  }

  if (keys) {
    if (filter) {
      return keys
        .filter((k) => k.startsWith(filter))
        .map((k) => k.slice(filter.length));
    }
    return keys;
  }

  return oneLineEval(buffer);
}

builtinLibs.forEach((name) => {
  const setReal = (val) => {
    delete global[name];
    global[name] = val;
  };

  Object.defineProperty(global, name, {
    get: () => {
      const lib = require(name);
      delete global[name];
      Object.defineProperty(global, name, {
        get: () => lib,
        set: setReal,
        configurable: true,
        enumerable: false,
      });

      return lib;
    },
    set: setReal,
    configurable: true,
    enumerable: false,
  });
});

{
  const module = new Module(process.cwd());
  global.module = module;
  module._compile('module.exports = require', process.cwd());
  global.require = module.exports;
}

global.REPL = {
  time: (fn) => {
    const { Suite } = require('benchmark');
    let r;
    new Suite().add(fn.name, fn)
      .on('cycle', (event) => {
        r = event.target;
        r[util.inspect.custom] = () => String(r);
      })
      .run();
    return r;
  },
  last: undefined,
  lastError: undefined,
};

// TODO: scope this
Object.defineProperties(global, {
  _: {
    enumerable: false,
    configurable: true,
    get: () => global.REPL.last,
    set: (v) => {
      delete global._;
      global._ = v;
    },
  },
  _err: {
    enumerable: false,
    configurable: true,
    get: () => global.REPL.lastError,
    set: (v) => {
      delete global._err;
      global._err = v;
    },
  },
});

const engines = [
  'V8',
  'ChakraCore',
];

let engine = engines.find((e) => process.versions[e.toLowerCase()] !== undefined);
if (engine !== undefined) {
  engine = `(${engine} ${process.versions[engine.toLowerCase()]})`;
}

const io = new IO(
  process.stdout, process.stdin,
  onLine, onAutocomplete, (s) => highlight(s),
  `Node.js ${process.version} ${engine || '(Unknown Engine)'}
Prototype REPL - https://github.com/nodejs/repl`,
);

io.setPrefix('> ');

process.setUncaughtExceptionCaptureCallback((e) => {
  process.stdout.write(`${inspect(e)}\n> `);
});

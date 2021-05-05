'use strict';

const emphasize = require('emphasize');
const chalk = require('chalk');

const windows = process.platform === 'win32';
const sheet = {
  'comment': chalk.gray,
  'quote': chalk.gray,

  'keyword': chalk.green,
  'addition': chalk.green,

  'number': windows ? chalk.yellow : chalk.blue,
  'string': chalk.green,
  'meta meta-string': chalk.cyan,
  'literal': chalk.cyan,
  'doctag': chalk.cyan,
  'regexp': chalk.cyan,

  'attribute': undefined,
  'attr': undefined,
  'variable': chalk.yellow,
  'template-variable': chalk.yellow,
  'class title': chalk.yellow,
  'type': chalk.yellow,

  'symbol': chalk.magenta,
  'bullet': chalk.magenta,
  'subst': chalk.magenta,
  'meta': chalk.magenta,
  'meta keyword': chalk.magenta,
  'link': chalk.magenta,

  'built_in': chalk.cyan,
  'deletion': chalk.red,

  'emphasis': chalk.italic,
  'strong': chalk.bold,
  'formula': chalk.inverse,
};

module.exports = (s) =>
  emphasize.highlight('ts', s, sheet).value;

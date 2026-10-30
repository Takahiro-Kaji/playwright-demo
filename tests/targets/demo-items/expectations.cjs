'use strict';
// Reuse the original, predetermined case contract; never derive it from observations.
const expected = require('../../cases.cjs').find((scenario) => scenario.id === 'both-unavailable');
module.exports = { expected };

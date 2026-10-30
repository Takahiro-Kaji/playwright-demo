'use strict';
// Expected values are declared BEFORE the request; never inferred from its response.
module.exports = [
  { id: 'both-ok', change: { a: 200, b: 200 }, mock: { a: 200, b: 200 }, http: { a: 201, b: 201 }, db: 'before-after' },
  { id: 'both-unavailable', change: { a: 503, b: 503 }, mock: { a: 503, b: 503 }, http: { a: 502, b: 502 }, db: 'before-after' },
  { id: 'mixed', change: { a: 200, b: 503 }, mock: { a: 200, b: 503 }, http: { a: 201, b: 502 }, db: 'before-after' },
  { id: 'no-switch', change: null, mock: { a: 200, b: 200 }, http: { a: 201, b: 201 }, db: 'after-only' },
];

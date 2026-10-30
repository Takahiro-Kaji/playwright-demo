'use strict';
// Require a 1 ms inward margin for cross-process clock resolution; never widen the interval.
function overlap(operation, samples) {
  const inside = samples.filter((s) => s.start >= operation.start + 1 && s.end <= operation.end - 1);
  for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++) {
    if (inside[i].count !== inside[j].count) return { status: 'established', first: inside[i], second: inside[j] };
  }
  return { status: 'unconfirmed', sampleCount: inside.length };
}
module.exports = { overlap };

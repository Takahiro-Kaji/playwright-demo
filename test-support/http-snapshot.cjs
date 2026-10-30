'use strict';
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
async function captureJson(url, dest, { timeoutMs = 10000, maxBytes = 16 * 1024 * 1024 } = {}) {
  const partial = `${dest}.${randomUUID()}.partial`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw new Error('Upstream exceeds size limit'); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
    await fs.writeFile(partial, body, { mode: 0o600, flag: 'wx' });
    await fs.rename(partial, dest);
    return { sha256: createHash('sha256').update(body).digest('hex'), bytes: size, count: parsed.length };
  } finally { await fs.rm(partial, { force: true }); }
}
module.exports = { captureJson };

'use strict';
const { spawn } = require('node:child_process');

/** Run a CLI directly (never via shell), with bounded time and output. */
function runCommand(file, args, { input = '', timeoutMs = 75_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let tooMuchOutput = false;
    let finished = false;
    const child = spawn(file, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    function append(current, chunk) {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > 1024 * 1024) {
        tooMuchOutput = true;
        child.kill('SIGKILL');
      }
      return next;
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', (err) => {
      // EPIPE is expected if the command quits before consuming stdin.
      if (err.code !== 'EPIPE' && !finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(new Error(`${file} could not start: ${err.message}`));
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (finished) return;
      finished = true;
      if (timedOut) return reject(new Error(`${file} timed out after ${timeoutMs}ms`));
      if (tooMuchOutput) return reject(new Error(`${file} output exceeded 1 MiB`));
      if (code !== 0) {
        // Do not include command arguments or env: those may contain identifiers/secrets.
        const detail = stderr.trim().slice(0, 1200);
        return reject(new Error(`${file} exited with ${code ?? signal}: ${detail}`));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(input);
  });
}

module.exports = { runCommand };

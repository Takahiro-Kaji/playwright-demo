import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDatabaseConfig } from './order-probe.ts';

test('probe DB uses the supplied CA and verifies certificate and hostname', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sso-probe-config-'));
  try {
    const ca = join(dir, 'ca.pem'); writeFileSync(ca, 'test-ca');
    const config = probeDatabaseConfig({ AWS_SSO_DB_HOST: 'db.example.rds.amazonaws.com', AWS_SSO_DB_USER: 'test', AWS_SSO_DB_PASSWORD: 'test', AWS_SSO_DB_CA_FILE: ca });
    assert.equal(config.ssl.ca.toString(), 'test-ca');
    assert.equal(config.ssl.rejectUnauthorized, true);
    assert.equal(config.ssl.verifyIdentity, true);
    assert.throws(() => probeDatabaseConfig({ AWS_SSO_DB_HOST: 'localhost', AWS_SSO_DB_USER: 'test', AWS_SSO_DB_PASSWORD: 'test', AWS_SSO_DB_CA_FILE: ca }), /PROBE_DB_CONFIG_REQUIRED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

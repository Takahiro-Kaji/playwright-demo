import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateTunnelSettings } from '../../aws-sales/mysql-tunnel.ts';
const good={runId:'0123456789abcdef0123456789abcdef',context:'eks-tokyo',pod:'sales-app-123abc-abc12',dbHost:'database.region.rds.amazonaws.com',dbUser:'tester',dbPassword:'test',caFile:'/tmp/test-ca.pem'};
test('非公開RDSのトンネルは安全でない対象や設定不足を拒否する',()=>{
  assert.doesNotThrow(()=>validateTunnelSettings(good));
  for (const override of [{runId:'../../bad'},{context:'-unsafe'},{pod:'other-pod'},{dbHost:'localhost'},{dbPassword:''}])
    assert.throws(()=>validateTunnelSettings({...good,...override}));
});

test('execの失敗をDB接続失敗として報告する', async () => {
  const {mkdtempSync,writeFileSync,chmodSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {createTunnelPool}=await import('../../aws-sales/mysql-tunnel.ts');
  const dir=mkdtempSync(join(tmpdir(),'sales-tunnel-'));
  const originalPath=process.env.PATH;
  const executable=join(dir,'kubectl');
  try {
    writeFileSync(executable,`#!${process.execPath}\nprocess.exit(17)\n`);
    chmodSync(executable,0o700);
    const ca=join(dir,'ca.pem');
    writeFileSync(ca,'test');
    process.env.PATH=dir;
    const pool=createTunnelPool({...good,caFile:ca});
    try { await assert.rejects(pool.getConnection()); } finally { await pool.end(); }
  } finally {
    process.env.PATH=originalPath;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('kubectlの欠落をDB接続失敗として報告する', async () => {
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {createTunnelPool}=await import('../../aws-sales/mysql-tunnel.ts');
  const dir=mkdtempSync(join(tmpdir(),'sales-tunnel-'));
  const originalPath=process.env.PATH;
  try {
    const ca=join(dir,'ca.pem');
    writeFileSync(ca,'test');
    process.env.PATH=dir;
    const pool=createTunnelPool({...good,caFile:ca});
    try { await assert.rejects(pool.getConnection()); } finally { await pool.end(); }
  } finally {
    process.env.PATH=originalPath;
    rmSync(dir,{recursive:true,force:true});
  }
});

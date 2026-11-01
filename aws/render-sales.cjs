'use strict';
const fs = require('node:fs');
const values = {SALES_IMAGE:process.env.SALES_IMAGE || '', DB_HOST:process.env.DB_HOST || '', SALES_UPSTREAM_MODE:process.env.SALES_UPSTREAM_MODE || 'upstream', SALES_CATALOG:JSON.stringify({catalogVersion:1,products:[{productCode:'P001',name:'ペン',price:120,active:true,quantity:5},{productCode:'P002',name:'ノート',price:300,active:true,quantity:2}]})};
// Namespaces and schemas are distinct for each test run. This only renders
// configuration; ownership, credentials, ingress and cleanup are separate.
const runId = process.env.SALES_RUN_ID || '';
if (runId && !/^[a-f0-9]{32}$/.test(runId)) throw Error('SALES_RUN_ID_INVALID');
values.SALES_NAMESPACE = runId ? `sales-test-${runId}` : 'integration-demo';
values.SALES_DB_NAME = runId ? `sales_test_${runId}` : 'integration_demo';
values.SALES_RUN_LABEL = runId || 'standard';
if (!['upstream','mock'].includes(values.SALES_UPSTREAM_MODE)) throw Error('SALES_UPSTREAM_MODE_INVALID');
if (!/^[a-zA-Z0-9.-]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$/.test(values.SALES_IMAGE)) throw Error('SALES_IMAGE_INVALID');
if (!/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(values.DB_HOST)) throw Error('DB_HOST_INVALID');
const template = fs.readFileSync(`${__dirname}/k8s/sales.yaml.tpl`,'utf8');
process.stdout.write(template.replace(/\$\{([A-Z_]+)\}/g, (_,k) => { if (!Object.hasOwn(values,k)) throw Error('UNKNOWN_VARIABLE'); return values[k]; }));

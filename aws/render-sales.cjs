'use strict';
const fs = require('node:fs');
const values = {SALES_IMAGE:process.env.SALES_IMAGE || '', DB_HOST:process.env.DB_HOST || ''};
if (!/^[a-zA-Z0-9.-]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$/.test(values.SALES_IMAGE)) throw Error('SALES_IMAGE_INVALID');
if (!/^[a-z0-9.-]+\.rds\.amazonaws\.com$/.test(values.DB_HOST)) throw Error('DB_HOST_INVALID');
const template = fs.readFileSync(`${__dirname}/k8s/sales.yaml.tpl`,'utf8');
process.stdout.write(template.replace(/\$\{([A-Z_]+)\}/g, (_,k) => { if (!Object.hasOwn(values,k)) throw Error('UNKNOWN_VARIABLE'); return values[k]; }));

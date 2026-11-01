'use strict';
const fs = require('node:fs');
const net = require('node:net');
const required = ['CERTIFICATE_ARN', 'OPERATOR_CIDR', 'USER_POOL_ARN', 'USER_POOL_CLIENT_ID', 'USER_POOL_DOMAIN', 'UI_HOST'];
const value = Object.fromEntries(required.map((k) => [k, process.env[k] || '']));
if (!/^arn:[a-z0-9-]+:acm:[a-z0-9-]+:\d{12}:certificate\/[a-f0-9-]+$/.test(value.CERTIFICATE_ARN) ||
    !/^arn:[a-z0-9-]+:cognito-idp:[a-z0-9-]+:\d{12}:userpool\/[a-zA-Z0-9_-]+$/.test(value.USER_POOL_ARN) ||
    !/^[a-zA-Z0-9]+$/.test(value.USER_POOL_CLIENT_ID) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.USER_POOL_DOMAIN) ||
    !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/.test(value.UI_HOST)) throw Error('Invalid ingress configuration');
const parts = value.OPERATOR_CIDR.split('/');
if (parts.length !== 2 || net.isIP(parts[0]) !== 4 || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(parts[1])) throw Error('OPERATOR_CIDR must be a restricted IPv4 CIDR');
const template = fs.readFileSync(`${__dirname}/ingress.yaml.tpl`, 'utf8');
process.stdout.write(template.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
  if (!Object.hasOwn(value, key)) throw Error('Unknown placeholder');
  return value[key];
}));

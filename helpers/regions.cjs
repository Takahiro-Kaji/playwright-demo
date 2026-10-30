'use strict';
const { required } = require('./kubernetes.cjs');
function regions() {
  const result = ['A', 'B'].map((key) => ({
    key: key.toLowerCase(), region: required(`REGION_${key}`), context: process.env.TEST_PROFILE === 'local' ? `local-${key}` : required(`KUBE_CONTEXT_${key}`),
    appUrl: required(`APP_URL_${key}`), mockUrl: required(`MOCK_URL_${key}`), adminUrl: required(`MOCK_ADMIN_URL_${key}`),
  }));
  if (process.env.TEST_PROFILE === 'local') {
    for (const target of result) for (const url of [target.appUrl, target.mockUrl, target.adminUrl]) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Local profile requires loopback HTTP URLs');
    }
    const base = new URL(required('BASE_URL'));
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Local base URL must use loopback');
  }
  if (result[0].region === result[1].region || result[0].context === result[1].context) throw new Error('Two different regions and Kubernetes contexts are required');
  return result;
}
module.exports = { regions };

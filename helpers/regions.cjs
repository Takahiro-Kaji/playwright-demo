'use strict';
const { required } = require('./kubernetes.cjs');
function regions() {
  const result = ['A', 'B'].map((key) => ({
    key: key.toLowerCase(), region: required(`REGION_${key}`), context: required(`KUBE_CONTEXT_${key}`),
    appUrl: required(`APP_URL_${key}`), mockUrl: required(`MOCK_URL_${key}`), adminUrl: required(`MOCK_ADMIN_URL_${key}`),
  }));
  if (result[0].region === result[1].region || result[0].context === result[1].context) throw new Error('Two different regions and Kubernetes contexts are required');
  return result;
}
module.exports = { regions };

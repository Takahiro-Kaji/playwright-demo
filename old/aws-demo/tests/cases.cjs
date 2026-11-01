'use strict';
// Expected values are declared BEFORE requests and are common to both regions.
// changeStatus: null means keep current settings, but still assert both mock responses.
module.exports = [
  {
    id: 'both-ok', changeStatus: 200, mockStatus: 200, httpStatus: 201,
    ui: { text: '作成しました', role: 'status', state: 'success', live: 'polite' },
    db: 'before-after',
  },
  {
    id: 'both-unavailable', changeStatus: 503, mockStatus: 503, httpStatus: 502,
    ui: { text: '外部システムエラー', role: 'alert', state: 'error', live: 'assertive' },
    db: 'before-after',
  },
  {
    id: 'no-switch', changeStatus: null, mockStatus: 200, httpStatus: 201,
    ui: { text: '作成しました', role: 'status', state: 'success', live: 'polite' },
    db: 'after-only',
  },
];

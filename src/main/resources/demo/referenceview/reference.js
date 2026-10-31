document.querySelector('[data-testid="refresh"]').addEventListener('click', async () => {
  const result = document.querySelector('[data-testid="result"]');
  result.dataset.state = 'loading';
  try { const r = await fetch('/api/reference'); if (!r.ok) throw Error('request failed'); const body = await r.json(); result.textContent = '親データ: ' + body.count + '件'; result.dataset.state = 'ready'; }
  catch (_) { result.textContent = '参照できません'; result.dataset.state = 'error'; }
});

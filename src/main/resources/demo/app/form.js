document.getElementById('item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = document.querySelector('[data-testid="item-create-result"]');
  const form = event.currentTarget;
  result.setAttribute('role', 'status');
  result.setAttribute('aria-live', 'polite');
  result.dataset.state = 'loading';
  result.textContent = '登録中';
  try {
    const response = await fetch('/api/items', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({testKey:form.elements.testKey.value})
    });
    if (response.ok) { result.dataset.state = 'success'; result.textContent = '作成しました'; }
    else { result.setAttribute('role', 'alert'); result.setAttribute('aria-live', 'assertive'); result.dataset.state = 'error'; result.textContent = response.status === 502 ? '外部システムエラー' : '登録できませんでした'; }
  } catch (_) { result.setAttribute('role', 'alert'); result.setAttribute('aria-live', 'assertive'); result.dataset.state = 'error'; result.textContent = '通信エラー'; }
});

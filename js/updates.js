(() => {
  const container = document.querySelector('[data-updates-list]');
  if (!container) return;

  const escapeHtml = (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const formatDate = (value) => {
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const renderTags = (tags = []) => tags
    .map((tag) => `<span class="lab-tag">${escapeHtml(tag)}</span>`)
    .join('');

  const renderUpdate = (update, index) => {
    const link = update.link || '#';
    const tilt = index % 2 === 0 ? 'tilt-left' : 'tilt-right';
    return `
      <a class="lab-card update-card ${tilt}" href="${escapeHtml(link)}" aria-label="Read update: ${escapeHtml(update.title)}">
        <span class="lab-date">${escapeHtml(formatDate(update.date))}</span>
        <h3>${escapeHtml(update.title)}</h3>
        <p>${escapeHtml(update.summary)}</p>
        <div class="lab-tags">${renderTags(update.tags)}</div>
      </a>
    `;
  };

  fetch('/data/updates.json')
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load updates: ${response.status}`);
      return response.json();
    })
    .then((updates) => {
      container.innerHTML = updates.map(renderUpdate).join('');
    })
    .catch((error) => {
      console.error(error);
      container.innerHTML = '<p class="lab-empty">Updates are being tuned. Check back after the next build passes through the lab.</p>';
    });
})();

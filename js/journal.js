(() => {
  const container = document.querySelector('[data-journal-list]');
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
    return date.toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const renderTags = (tags = []) => tags
    .map((tag) => `<span class="lab-tag quiet">${escapeHtml(tag)}</span>`)
    .join('');

  const renderEntry = (entry, index) => {
    const tilt = index % 2 === 0 ? 'tilt-right' : 'tilt-left';
    return `
      <a class="lab-card journal-card ${tilt}" href="${escapeHtml(entry.link)}" aria-label="Read journal entry: ${escapeHtml(entry.title)}">
        <div class="journal-card__meta">
          <span class="lab-date">${escapeHtml(formatDate(entry.date))}</span>
          <span class="journal-card__id">${escapeHtml(entry.id)}</span>
        </div>
        <h3>${escapeHtml(entry.title)}</h3>
        <p>${escapeHtml(entry.excerpt)}</p>
        <div class="lab-tags">${renderTags(entry.tags)}</div>
        <span class="journal-read-link">Open field note</span>
      </a>
    `;
  };

  fetch('/data/journal.json')
    .then((response) => {
      if (!response.ok) throw new Error(`Could not load journal entries: ${response.status}`);
      return response.json();
    })
    .then((entries) => {
      container.innerHTML = entries.map(renderEntry).join('');
    })
    .catch((error) => {
      console.error(error);
      container.innerHTML = '<p class="lab-empty">The journal shelf is being assembled. New field notes will appear here soon.</p>';
    });
})();

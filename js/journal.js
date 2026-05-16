async function loadJournal() {
  const container = document.getElementById("journal-container");

  if (!container) {
    console.error("Missing #journal-container");
    return;
  }

  try {
    const response = await fetch("data/journal.json");

    if (!response.ok) {
      throw new Error("Could not load journal.json");
    }

    const entries = await response.json();

    container.innerHTML = "";

    entries.forEach(entry => {
      const card = document.createElement("a");
      card.className = "journal-card";
      card.href = entry.link;

      card.innerHTML = `
        <div class="journal-date">${entry.date}</div>
        <h3>${entry.title}</h3>
        <p>${entry.excerpt}</p>
        <div class="tags">
          ${entry.tags.map(tag => `<span>${tag}</span>`).join("")}
        </div>
      `;

      container.appendChild(card);
    });
  } catch (error) {
    console.error("Journal loading error:", error);
    container.innerHTML = `
      <div class="empty-journal">
        The journal shelf is being assembled. New field notes will appear here soon.
      </div>
    `;
  }
}

loadJournal();

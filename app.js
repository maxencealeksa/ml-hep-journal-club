/**
 * ML-HEP Journal Club Client Application
 * Clean, minimal interface for FastML & ETH Zurich researchers.
 * Supports any paper link (arXiv, OpenReview, Nature, etc.),
 * intuitive voting with voter names, and room/Zoom meeting coordination.
 */

(function () {
  'use strict';

  // Security Constants (Hashes for PIN & Zoom Kenncode)
  const PIN_HASH_FNV = 0xa24036fb;
  const ZOOM_KC_HASH_FNV = 0xb1c6710e;
  const ENCRYPTED_ZOOM_URL = [
    90, 68, 69, 68, 70, 8, 29, 31, 67, 67, 65, 90, 28, 74, 94, 91, 88, 31, 74,
    30, 85, 81, 26, 88, 29, 6, 9, 6, 2, 4, 3, 6, 2, 12, 7, 10, 13, 64, 70, 80,
    8, 80, 67, 3, 101, 82, 3, 118, 4, 114, 102, 124, 67, 3, 125, 113, 127, 82,
    113, 97, 127, 100, 88, 82, 0, 64, 72, 88, 2, 85, 108, 28, 3
  ];

  function fnv1aHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function verifyPinClient(pin) {
    if (!pin) return false;
    return fnv1aHash('ml_hep_pin:' + String(pin).trim()) === PIN_HASH_FNV;
  }

  function unlockZoomUrl(code) {
    if (!code) return null;
    const clean = String(code).trim();
    if (fnv1aHash('ml_hep_zoom:' + clean) !== ZOOM_KC_HASH_FNV) return null;
    const key = clean.repeat(20);
    return ENCRYPTED_ZOOM_URL.map((b, i) => String.fromCharCode(b ^ key.charCodeAt(i))).join('');
  }

  // Application State
  let state = {
    isServerMode: true,
    voterId: getOrCreateVoterId(),
    voterName: localStorage.getItem('ml_hep_user_name') || '',
    activeTab: 'voting', // 'voting' or 'discussed'
    searchQuery: '',
    papers: [],
    info: {
      room: 'HPK D 32',
      room_building: 'ETH Hönggerberg • Physics Building HPK, Floor D'
    }
  };

  // DOM Elements
  const DOM = {
    papersList: document.getElementById('papersList'),
    countVoting: document.getElementById('countVoting'),
    countDiscussed: document.getElementById('countDiscussed'),
    searchInput: document.getElementById('searchInput'),
    copyRoomBtn: document.getElementById('copyRoomBtn'),
    zoomLinkBtn: document.getElementById('zoomLinkBtn'),
    zoomModal: document.getElementById('zoomModal'),
    zoomForm: document.getElementById('zoomForm'),
    zoomKenncodeInput: document.getElementById('zoomKenncodeInput'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeIcon: document.getElementById('themeIcon'),
    openProposeModalBtn: document.getElementById('openProposeModalBtn'),
    addPaperModal: document.getElementById('addPaperModal'),
    addPaperForm: document.getElementById('addPaperForm'),
    arxivFetchBtn: document.getElementById('arxivFetchBtn'),
    statusModal: document.getElementById('statusModal'),
    statusForm: document.getElementById('statusForm'),
    statusSelect: document.getElementById('statusSelect'),
    statusAdminPin: document.getElementById('statusAdminPin'),
    deletePaperBtn: document.getElementById('deletePaperBtn'),
    statusPaperId: document.getElementById('statusPaperId'),
    statusPaperTitleDisplay: document.getElementById('statusPaperTitleDisplay'),
    toastContainer: document.getElementById('toastContainer')
  };

  // Voter ID Management
  function getOrCreateVoterId() {
    let id = localStorage.getItem('ml_hep_voter_id');
    if (!id) {
      id = 'voter_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      localStorage.setItem('ml_hep_voter_id', id);
    }
    return id;
  }

  // Toast Notification
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';
    const icon = type === 'success' ? '✓' : (type === 'error' ? '✕' : 'ℹ');
    toast.innerHTML = `<span style="font-weight:bold;color:var(--accent-cyan);margin-right:6px;">${icon}</span> <span>${message}</span>`;
    DOM.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  // Theme Management
  function initTheme() {
    const savedTheme = localStorage.getItem('ml_hep_theme') || 'dark';
    setTheme(savedTheme);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ml_hep_theme', theme);
    updateThemeIcon(theme);
  }

  function updateThemeIcon(theme) {
    if (theme === 'dark') {
      DOM.themeIcon.innerHTML = `
        <circle cx="12" cy="12" r="5"></circle>
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"></path>
      `;
      DOM.themeToggleBtn.setAttribute('title', 'Switch to Light Mode');
    } else {
      DOM.themeIcon.innerHTML = `
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      `;
      DOM.themeToggleBtn.setAttribute('title', 'Switch to Dark Mode');
    }
  }

  DOM.themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Clipboard Helpers
  function setupCopyButton(btn, text, label) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        showToast(`Copied ${label} to clipboard!`, 'success');
      }).catch(() => {
        showToast(`Failed to copy: ${text}`);
      });
    });
  }

  setupCopyButton(DOM.copyRoomBtn, state.info.room, 'Room (HPK D 32)');

  // Network / Data Layer
  async function loadInitialData() {
    try {
      const res = await fetch('/api/papers', {
        headers: {
          'X-Voter-ID': state.voterId,
          'X-Voter-Name': state.voterName
        }
      });
      if (res.ok) {
        state.isServerMode = true;
        const data = await res.json();
        state.papers = data.papers || [];
        renderPapers();
        return;
      }
    } catch (e) {
      console.warn('Backend server offline. Running in LocalStorage mode.', e);
    }

    // LocalStorage fallback
    state.isServerMode = false;
    loadPapersFromLocalStorage();
  }

  async function loadPapersFromLocalStorage() {
    const cached = localStorage.getItem('ml_hep_papers_v2');
    if (cached) {
      try {
        state.papers = JSON.parse(cached);
        renderPapers();
        return;
      } catch (e) {}
    }

    // Load seed_data.json
    try {
      const res = await fetch('seed_data.json');
      if (res.ok) {
        const seed = await res.json();
        state.papers = seed.map(p => ({
          ...p,
          user_has_voted: false
        }));
        savePapersToLocalStorage();
        renderPapers();
        return;
      }
    } catch (e) {}

    renderPapers();
  }

  function savePapersToLocalStorage() {
    localStorage.setItem('ml_hep_papers_v2', JSON.stringify(state.papers));
  }

  // Voting Logic with Required Name & Duplicate Prevention
  async function toggleVote(paperId) {
    const paper = state.papers.find(p => p.id === paperId);
    if (!paper) return;

    // Require user name before voting
    if (!state.voterName) {
      const name = prompt('Please enter your name to vote (required):', '');
      if (!name || !name.trim()) {
        showToast('Please enter your name to vote', 'error');
        return;
      }
      state.voterName = name.trim();
      localStorage.setItem('ml_hep_user_name', state.voterName);
    }

    const currentVoters = Array.isArray(paper.voters) ? [...paper.voters] : [];
    const nameMatchIndex = currentVoters.findIndex(
      v => v.toLowerCase() === state.voterName.toLowerCase()
    );
    const previousHasVoted = !!paper.user_has_voted || nameMatchIndex > -1;
    const previousVotes = paper.votes || 0;

    // Optimistic UI update
    paper.user_has_voted = !previousHasVoted;
    if (paper.user_has_voted) {
      if (nameMatchIndex === -1) {
        currentVoters.push(state.voterName);
        paper.votes = previousVotes + 1;
      }
    } else {
      if (nameMatchIndex > -1) {
        currentVoters.splice(nameMatchIndex, 1);
      }
      paper.votes = Math.max(0, previousVotes - 1);
    }
    paper.voters = currentVoters;

    renderPapers();

    if (state.isServerMode) {
      try {
        const res = await fetch(`/api/papers/${encodeURIComponent(paperId)}/vote`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Voter-ID': state.voterId,
            'X-Voter-Name': state.voterName
          },
          body: JSON.stringify({ name: state.voterName })
        });
        if (res.ok) {
          const result = await res.json();
          paper.votes = result.votes;
          paper.user_has_voted = result.has_voted;
          if (result.voters) paper.voters = result.voters;
          renderPapers();
          showToast(result.has_voted ? 'Vote registered!' : 'Vote removed.');
        } else {
          const err = await res.json().catch(() => ({}));
          paper.user_has_voted = previousHasVoted;
          paper.votes = previousVotes;
          renderPapers();
          showToast(err.error || 'Failed to register vote', 'error');
        }
      } catch (e) {
        paper.user_has_voted = previousHasVoted;
        paper.votes = previousVotes;
        renderPapers();
        showToast('Network error while voting', 'error');
      }
    } else {
      savePapersToLocalStorage();
      showToast(paper.user_has_voted ? 'Vote registered!' : 'Vote removed.');
    }
  }

  // Rendering Papers List
  function renderPapers() {
    const votingCount = state.papers.filter(p => (p.status || 'voting') === 'voting').length;
    const discussedCount = state.papers.filter(p => p.status === 'discussed').length;

    DOM.countVoting.textContent = votingCount;
    DOM.countDiscussed.textContent = discussedCount;

    // Filter by active tab
    let filtered = state.papers.filter(p => (p.status || 'voting') === state.activeTab);

    // Search query filter
    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase();
      filtered = filtered.filter(p => {
        const titleMatch = (p.title || '').toLowerCase().includes(q);
        const authorMatch = (p.authors || '').toLowerCase().includes(q);
        const notesMatch = (p.notes || '').toLowerCase().includes(q);
        return titleMatch || authorMatch || notesMatch;
      });
    }

    if (filtered.length === 0) {
      DOM.papersList.innerHTML = `
        <div class="empty-state">
          <p>No papers found in this section.</p>
        </div>
      `;
      return;
    }

    DOM.papersList.innerHTML = filtered.map(paper => renderPaperCard(paper)).join('');

    // Attach event listeners
    DOM.papersList.querySelectorAll('.intuitive-vote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-paper-id');
        toggleVote(id);
      });
    });

    DOM.papersList.querySelectorAll('.manage-status-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-paper-id');
        openStatusModal(id);
      });
    });
  }

  // Helper to extract clean domain source badge for non-arXiv links
  function getSourceBadge(url, arxivId) {
    if (arxivId) {
      return `<span class="badge badge-source">arXiv:${escapeHtml(arxivId)}</span>`;
    }
    if (!url) return '';
    try {
      const hostname = new URL(url).hostname.replace('www.', '');
      return `<span class="badge badge-source">${escapeHtml(hostname)}</span>`;
    } catch (e) {
      return `<span class="badge badge-source">Paper Link</span>`;
    }
  }

  function sanitizeUrl(url) {
    if (!url) return '#';
    const trimmed = String(url).trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    return '#';
  }

  function renderPaperCard(paper) {
    const isVoted = !!paper.user_has_voted;
    const votes = paper.votes || 0;
    const isDiscussed = paper.status === 'discussed';

    const sourceBadge = getSourceBadge(paper.url, paper.arxiv_id);
    const discussedBadge = isDiscussed ? `<span class="badge badge-discussed">Discussed ${paper.discussed_date ? '(' + escapeHtml(paper.discussed_date) + ')' : ''}</span>` : '';

    // Voters list text (e.g., "Votes (4): Marie, Donatella, Philip, Maxence")
    let votersHtml = '';
    if (Array.isArray(paper.voters) && paper.voters.length > 0) {
      votersHtml = `<div class="voters-preview"><strong>Votes:</strong> ${escapeHtml(paper.voters.join(', '))}</div>`;
    } else if (paper.notes && paper.notes.includes('votes:')) {
      votersHtml = `<div class="voters-preview">${escapeHtml(paper.notes)}</div>`;
    }

    const safePaperUrl = sanitizeUrl(paper.url);
    const safePdfUrl = paper.pdf_url ? sanitizeUrl(paper.pdf_url) : '';

    // Direct PDF link if available
    const pdfLink = (paper.pdf_url && safePdfUrl !== '#') ? `
      <a href="${safePdfUrl}" target="_blank" rel="noopener noreferrer" class="paper-link-btn" title="Open PDF">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <span>PDF</span>
      </a>
    ` : '';

    return `
      <article class="paper-card">
        <div class="paper-main">
          <div class="paper-header-row">
            ${sourceBadge}
            ${discussedBadge}
          </div>

          <h3 class="paper-title">
            <a href="${safePaperUrl}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(paper.title)}
            </a>
          </h3>

          ${paper.authors ? `<div class="paper-authors">${escapeHtml(paper.authors)}</div>` : ''}
          ${votersHtml}

          <div class="paper-links-row">
            <a href="${safePaperUrl}" target="_blank" rel="noopener noreferrer" class="paper-link-btn">
              <span>Open Paper</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a>
            ${pdfLink}
            <button class="copy-btn manage-status-btn" data-paper-id="${escapeHtml(paper.id)}" title="Manage status / delete" style="margin-left:auto;font-size:0.75rem;color:var(--text-muted);">
              Manage
            </button>
          </div>
        </div>

        <!-- Intuitive Voting Button -->
        <div class="paper-vote-zone">
          <button class="intuitive-vote-btn ${isVoted ? 'voted' : ''}" data-paper-id="${escapeHtml(paper.id)}" title="${isVoted ? 'Click to remove your vote' : 'Click to vote for this paper'}">
            <span class="vote-icon">${isVoted ? '✓' : '▲'}</span>
            <span class="vote-label">${isVoted ? 'Voted' : 'Vote'}</span>
            <span class="vote-count-pill">${votes}</span>
          </button>
        </div>
      </article>
    `;
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Tab Listeners
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      state.activeTab = btn.getAttribute('data-tab');
      renderPapers();
    });
  });

  // Search input
  DOM.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderPapers();
  });

  // Modal Helpers
  function openModal(modal) {
    modal.classList.add('open');
  }

  function closeModal(modal) {
    modal.classList.remove('open');
  }

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close-modal');
      const target = document.getElementById(modalId);
      if (target) closeModal(target);
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      closeModal(e.target);
    }
  });

  DOM.openProposeModalBtn.addEventListener('click', () => {
    if (state.voterName) {
      document.getElementById('paperVoterName').value = state.voterName;
    }
    openModal(DOM.addPaperModal);
  });

  // Zoom Protected Modal (Asks for Kenncode before redirecting)
  if (DOM.zoomLinkBtn && DOM.zoomModal && DOM.zoomForm) {
    DOM.zoomLinkBtn.addEventListener('click', () => {
      DOM.zoomKenncodeInput.value = '';
      openModal(DOM.zoomModal);
      setTimeout(() => DOM.zoomKenncodeInput.focus(), 50);
    });

    DOM.zoomForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = DOM.zoomKenncodeInput.value.trim();
      const zoomUrl = unlockZoomUrl(code);
      if (!zoomUrl) {
        showToast('Incorrect Zoom Kenncode', 'error');
        DOM.zoomKenncodeInput.focus();
        return;
      }
      closeModal(DOM.zoomModal);
      DOM.zoomKenncodeInput.value = '';
      window.open(zoomUrl, '_blank', 'noopener,noreferrer');
    });
  }

  // arXiv Auto-fetch (Only triggers if user enters an arXiv link)
  DOM.arxivFetchBtn.addEventListener('click', async () => {
    const rawUrl = document.getElementById('paperUrl').value.trim();
    if (!rawUrl) {
      showToast('Enter an arXiv URL or ID first', 'error');
      return;
    }

    const match = rawUrl.match(/(\d{4}\.\d{4,5}(v\d+)?)|([a-z\-]+(\.[A-Z]{2})?\/\d{7})/i);
    if (!match) {
      showToast('Not an arXiv link (you can still enter the title and link directly!)', 'info');
      return;
    }

    const arxivId = match[0];
    DOM.arxivFetchBtn.disabled = true;
    DOM.arxivFetchBtn.textContent = 'Fetching...';

    try {
      if (state.isServerMode) {
        const res = await fetch(`/api/arxiv?id=${encodeURIComponent(arxivId)}`);
        const data = await res.json();
        if (data.success) {
          document.getElementById('paperTitle').value = data.title;
          document.getElementById('paperAuthors').value = data.authors;
          document.getElementById('paperUrl').value = data.url;
          showToast(`Retrieved metadata for arXiv:${arxivId}!`, 'success');
        } else {
          showToast(`arXiv query error: ${data.error}`, 'error');
        }
      } else {
        document.getElementById('paperUrl').value = `https://arxiv.org/abs/${arxivId}`;
        showToast(`Detected arXiv:${arxivId}`, 'info');
      }
    } catch (e) {
      showToast('Could not query arXiv API', 'error');
    } finally {
      DOM.arxivFetchBtn.disabled = false;
      DOM.arxivFetchBtn.textContent = 'Auto-fill (arXiv)';
    }
  });

  // Add Paper Form Submission
  DOM.addPaperForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const url = document.getElementById('paperUrl').value.trim();
    const title = document.getElementById('paperTitle').value.trim();
    const authors = document.getElementById('paperAuthors').value.trim();
    const voterName = document.getElementById('paperVoterName').value.trim();

    if (!url || !title) {
      showToast('Title and URL are required', 'error');
      return;
    }

    if (!voterName) {
      showToast('Please enter your name', 'error');
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      showToast('URL must start with https:// or http://', 'error');
      return;
    }

    state.voterName = voterName;
    localStorage.setItem('ml_hep_user_name', voterName);

    // Check if it's an arXiv link for convenience
    let arxivId = '';
    const match = url.match(/(\d{4}\.\d{4,5}(v\d+)?)|([a-z\-]+(\.[A-Z]{2})?\/\d{7})/i);
    if (match) arxivId = match[0];

    const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : (url.endsWith('.pdf') ? url : '');

    const newPaper = {
      id: 'paper-' + Date.now(),
      title,
      authors,
      url,
      pdf_url: pdfUrl,
      arxiv_id: arxivId,
      status: 'voting',
      voter_name: voterName,
      votes: 1,
      voters: [voterName],
      user_has_voted: true,
      created_at: new Date().toISOString()
    };

    if (state.isServerMode) {
      try {
        const res = await fetch('/api/papers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Voter-ID': state.voterId,
            'X-Voter-Name': voterName
          },
          body: JSON.stringify(newPaper)
        });
        if (res.ok) {
          showToast('Paper added!', 'success');
          closeModal(DOM.addPaperModal);
          DOM.addPaperForm.reset();
          await loadInitialData();
          return;
        } else {
          const errData = await res.json().catch(() => ({}));
          showToast(errData.error || 'Could not add paper', 'error');
        }
      } catch (e) {
        showToast('Network error adding paper', 'error');
      }
    } else {
      state.papers.push(newPaper);
      savePapersToLocalStorage();
      renderPapers();
      showToast('Paper added!', 'success');
      closeModal(DOM.addPaperModal);
      DOM.addPaperForm.reset();
    }
  });

  // Paper Status Management Modal (Protected by Admin PIN)
  function openStatusModal(paperId) {
    const paper = state.papers.find(p => p.id === paperId);
    if (!paper) return;

    DOM.statusPaperId.value = paper.id;
    DOM.statusPaperTitleDisplay.textContent = paper.title;
    DOM.statusSelect.value = paper.status || 'voting';
    if (DOM.statusAdminPin) DOM.statusAdminPin.value = '';
    openModal(DOM.statusModal);
  }

  DOM.statusForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const paperId = DOM.statusPaperId.value;
    const newStatus = DOM.statusSelect.value;
    const pin = DOM.statusAdminPin ? DOM.statusAdminPin.value.trim() : '';

    if (!verifyPinClient(pin)) {
      showToast('Invalid Admin PIN', 'error');
      if (DOM.statusAdminPin) DOM.statusAdminPin.focus();
      return;
    }

    const paper = state.papers.find(p => p.id === paperId);
    if (!paper) return;

    const discussedDate = (newStatus === 'discussed' && !paper.discussed_date)
      ? new Date().toISOString().split('T')[0]
      : (paper.discussed_date || '');

    if (state.isServerMode) {
      try {
        const res = await fetch(`/api/papers/${encodeURIComponent(paperId)}/status`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-PIN': pin
          },
          body: JSON.stringify({ status: newStatus, discussed_date: discussedDate, pin })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.error || 'Invalid Admin PIN', 'error');
          return;
        }
        showToast('Status updated!', 'success');
        closeModal(DOM.statusModal);
        await loadInitialData();
      } catch (e) {
        showToast('Error updating status', 'error');
      }
    } else {
      paper.status = newStatus;
      paper.discussed_date = discussedDate;
      savePapersToLocalStorage();
      renderPapers();
      showToast('Status updated!', 'success');
      closeModal(DOM.statusModal);
    }
  });

  DOM.deletePaperBtn.addEventListener('click', async () => {
    const paperId = DOM.statusPaperId.value;
    const pin = DOM.statusAdminPin ? DOM.statusAdminPin.value.trim() : '';

    if (!verifyPinClient(pin)) {
      showToast('Enter the Admin PIN first to delete a paper', 'error');
      if (DOM.statusAdminPin) DOM.statusAdminPin.focus();
      return;
    }

    if (!confirm('Remove this paper?')) return;

    if (state.isServerMode) {
      try {
        const res = await fetch(`/api/papers/${encodeURIComponent(paperId)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-PIN': pin
          },
          body: JSON.stringify({ pin })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.error || 'Invalid Admin PIN', 'error');
          return;
        }
        showToast('Paper removed', 'info');
        closeModal(DOM.statusModal);
        await loadInitialData();
      } catch (e) {
        showToast('Error removing paper', 'error');
      }
    } else {
      state.papers = state.papers.filter(p => p.id !== paperId);
      savePapersToLocalStorage();
      renderPapers();
      showToast('Paper removed', 'info');
      closeModal(DOM.statusModal);
    }
  });

  // Initialization
  function init() {
    initTheme();
    loadInitialData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

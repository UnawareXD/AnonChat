document.addEventListener('DOMContentLoaded', () => {
  const requestCodeForm = document.getElementById('request-code-form');
  const verifyCodeForm = document.getElementById('verify-code-form');
  const registerForm = document.getElementById('register-form');
  const registerVerifyForm = document.getElementById('register-verify-form');
  const postForm = document.getElementById('post-form');
  const customIdentityForm = document.getElementById('custom-identity-form');
  const feedList = document.querySelector('.feed-list');
  const installButton = document.getElementById('install-button');
  let deferredPrompt = null;

  function escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderReactionButtons(post = {}) {
    const counts = post.reaction_counts || { likes: 0, dislikes: 0 };
    const userReaction = post.user_reaction || null;
    return `
      <div class="reaction-row">
        <button type="button" class="reaction-button ${userReaction === 'like' ? 'active' : ''}" data-post-id="${escapeHtml(post.id)}" data-reaction="like" data-active="${userReaction === 'like'}">
          Like <span>${Number(counts.likes || 0)}</span>
        </button>
        <button type="button" class="reaction-button ${userReaction === 'dislike' ? 'active' : ''}" data-post-id="${escapeHtml(post.id)}" data-reaction="dislike" data-active="${userReaction === 'dislike'}">
          Dislike <span>${Number(counts.dislikes || 0)}</span>
        </button>
      </div>
    `;
  }

  function renderReplyTree(replies = []) {
    if (!replies.length) {
      return '';
    }
    return `
      <div class="reply-stack">
        ${replies.map((reply) => `
          <div class="reply-card">
            <div class="post-header">
              <a href="/identities/${reply.identity_id}" class="identity-link">${escapeHtml(reply.public_identity || reply.username || 'Anonymous')}</a>
              <span class="post-meta">${escapeHtml(reply.kind || 'reply')}</span>
            </div>
            <p>${escapeHtml(reply.body || '')}</p>
            <div class="post-footer">
              <span>Value: $${((Number(reply.current_value_cents || 0)) / 100).toFixed(2)}</span>
              <span>${new Date(reply.created_at).toLocaleString()}</span>
            </div>
            ${renderReactionButtons(reply)}
            ${renderReplyTree(reply.replies || [])}
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderFeed(posts = []) {
    if (!feedList) {
      return;
    }
    if (!posts.length) {
      feedList.innerHTML = '<div class="empty-state">Nothing here yet.</div>';
      return;
    }

    feedList.innerHTML = posts.map((post) => `
      <article class="post-card" data-post-id="${escapeHtml(post.id)}">
        <div class="post-header">
          <a href="/identities/${post.identity_id}" class="identity-link">${escapeHtml(post.public_identity || post.username || 'Anonymous')}</a>
          <span class="post-meta">${escapeHtml(post.kind || 'post')}</span>
        </div>
        <p>${escapeHtml(post.body || '')}</p>
        <div class="post-footer">
          <span>Value: $${((Number(post.current_value_cents || 0)) / 100).toFixed(2)}</span>
          <span>${new Date(post.created_at).toLocaleString()}</span>
        </div>
        ${renderReactionButtons(post)}
        <div class="thread-actions">
          <a href="/posts/${post.id}" class="thread-link">Open thread</a>
        </div>
        ${renderReplyTree(post.replies || [])}
        <div class="reply-box">
          <form action="/api/posts/${post.id}/replies" method="POST" class="inline-form" data-ajax-form="true">
            <input type="text" name="body" placeholder="Reply anonymously" />
            <button type="submit">Reply</button>
          </form>
        </div>
      </article>
    `).join('');
  }

  async function refreshFeed() {
    try {
      const response = await fetch('/api/feed');
      const payload = await response.json();
      renderFeed(payload.posts || []);
    } catch (error) {
      console.error('Unable to refresh feed', error);
    }
  }

  async function submitJsonForm(form, { parseJson = true } = {}) {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    const response = await fetch(form.action, {
      method: form.method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (parseJson) {
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.error) {
        throw new Error(json.error || 'Request failed.');
      }
      return json;
    }

    return response;
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target && event.target.closest ? event.target.closest('form[data-ajax-form="true"]') : null;
    if (!form) {
      return;
    }
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton && submitButton.disabled) {
      return;
    }
    if (submitButton) {
      submitButton.disabled = true;
    }
    try {
      await submitJsonForm(form);
      if (form.action.includes('/api/auth/logout')) {
        window.location.href = '/login';
        return;
      }
      if (form.action.includes('/api/marketplace/offers/')) {
        window.location.reload();
        return;
      }
      if (document.querySelector('.feed-list')) {
        await refreshFeed();
      }
    } catch (error) {
      alert(error.message || 'Unable to complete request.');
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('.reaction-button');
    if (!button) {
      return;
    }
    event.preventDefault();
    const postId = button.dataset.postId;
    const reaction = button.dataset.reaction;
    const payload = { reaction };
    if (button.dataset.active === 'true') {
      payload.remove = true;
    }
    try {
      const response = await fetch(`/api/posts/${postId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await response.json();
      if (!response.ok || json.error) {
        throw new Error(json.error || 'Unable to save reaction.');
      }
      await refreshFeed();
    } catch (error) {
      alert(error.message || 'Unable to save reaction.');
    }
  });

  if (requestCodeForm) {
    requestCodeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const phone = document.getElementById('login-phone').value;
      const response = await fetch('/api/auth/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const payload = await response.json();
      if (!payload.ok) {
        alert(payload.error || 'Unable to request code.');
        return;
      }
      document.getElementById('login-phone-verify').value = phone;
      alert(`Development code: ${payload.code}`);
    });
  }

  if (verifyCodeForm) {
    verifyCodeForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const phone = document.getElementById('login-phone-verify').value || document.getElementById('login-phone').value;
      const code = document.getElementById('login-code').value;
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code })
      });
      const payload = await response.json();
      if (!payload.ok) {
        alert(payload.error || 'Unable to verify code.');
        return;
      }
      window.location.href = payload.redirect || '/feed';
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const phone = document.getElementById('register-phone').value;
      const response = await fetch('/api/auth/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const payload = await response.json();
      if (!payload.ok) {
        alert(payload.error || 'Unable to request code.');
        return;
      }
      document.getElementById('register-phone-field').value = phone;
      alert(`Development code: ${payload.code}`);
    });
  }

  if (registerVerifyForm) {
    registerVerifyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const phone = document.getElementById('register-phone-field').value || document.getElementById('register-phone').value;
      const code = document.getElementById('register-code').value;
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code })
      });
      const payload = await response.json();
      if (!payload.ok) {
        alert(payload.error || 'Unable to verify code.');
        return;
      }
      window.location.href = payload.redirect || '/feed';
    });
  }

  if (postForm) {
    postForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(postForm);
      const body = formData.get('body');
      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      });
      const payload = await response.json();
      if (payload.ok) {
        postForm.reset();
        await refreshFeed();
      } else {
        alert(payload.error || 'Unable to create post.');
      }
    });
  }

  if (customIdentityForm) {
    customIdentityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = customIdentityForm.querySelector('button[type="submit"]');
      if (button.disabled) {
        return;
      }
      button.disabled = true;
      const statusEl = document.getElementById('custom-identity-status');
      const formData = new FormData(customIdentityForm);
      try {
        const response = await fetch(customIdentityForm.action, {
          method: customIdentityForm.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: formData.get('username') })
        });
        const payload = await response.json();
        if (!response.ok || payload.error) {
          throw new Error(payload.error || 'Unable to create the permanent identity.');
        }
        if (statusEl) {
          statusEl.textContent = 'Permanent identity created. Returning to the feed...';
          statusEl.className = 'status-message success';
        }
        window.setTimeout(() => {
          window.location.href = '/feed';
        }, 2000);
      } catch (error) {
        if (statusEl) {
          statusEl.textContent = error.message || 'Unable to create the permanent identity.';
          statusEl.className = 'status-message error';
        } else {
          alert(error.message || 'Unable to create the permanent identity.');
        }
        button.disabled = false;
      }
    });
  }

  if (installButton) {
    installButton.addEventListener('click', async () => {
      if (!deferredPrompt) {
        installButton.textContent = 'Use browser menu → Install app';
        return;
      }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installButton.hidden = true;
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredPrompt = event;
      installButton.hidden = false;
      installButton.textContent = 'Install app';
    });
  }

  if (navigator.serviceWorker && window.location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  }

  if (feedList) {
    refreshFeed();
    if (window.EventSource) {
      let source = new EventSource('/api/events');
      source.addEventListener('feed-update', async () => {
        await refreshFeed();
      });
      source.onerror = () => {
        setTimeout(() => {
          if (source.readyState === EventSource.CLOSED) {
            source = new EventSource('/api/events');
            source.addEventListener('feed-update', async () => {
              await refreshFeed();
            });
          }
        }, 1000);
      };
    }
  }
});

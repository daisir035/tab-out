/* ================================================================
   ChiefDelphi Content Script

   Injected into chiefdelphi.com/t/* (Discourse topic pages).
   - Adds a floating "Follow this topic" button
   - When clicked, fetches topic JSON and saves to chrome.storage.local
   - Silently refreshes cached data when visiting an already-followed topic
   ================================================================ */

'use strict';

(function () {
  // Prevent double-injection
  if (window.__cdContentScriptLoaded) return;
  window.__cdContentScriptLoaded = true;

  const TOPIC_ID_REGEX = /\/t\/[^/]+\/(\d+)(?:\/\d+)?(?:\?.*)?$/;

  function getTopicId() {
    const match = window.location.pathname.match(TOPIC_ID_REGEX);
    return match ? match[1] : null;
  }

  async function getCdTopics() {
    const { cd_topics = [] } = await chrome.storage.local.get('cd_topics');
    return cd_topics;
  }

  async function saveCdTopic(topic) {
    const topics = await getCdTopics();
    const existing = topics.find(t => t.id === topic.id);
    if (existing) {
      // Merge in new data, keep addedAt
      Object.assign(existing, topic, { addedAt: existing.addedAt });
    } else {
      topics.push(topic);
    }
    await chrome.storage.local.set({ cd_topics: topics });
  }

  async function removeCdTopic(id) {
    let topics = await getCdTopics();
    topics = topics.filter(t => String(t.id) !== String(id));
    await chrome.storage.local.set({ cd_topics: topics });
  }

  async function fetchTopic(topicId) {
    const res = await fetch(`https://www.chiefdelphi.com/t/${topicId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchLatestPosts(topicId, postIds) {
    if (!postIds || postIds.length === 0) return [];
    const params = postIds.map(id => `post_ids[]=${id}`).join('&');
    const res = await fetch(`https://www.chiefdelphi.com/t/${topicId}/posts.json?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.post_stream?.posts || [];
  }

  function extractCategoryName() {
    // Try to read category from Discourse page meta or DOM
    const el = document.querySelector('[data-topic-id] .category-name, .topic-category .badge-wrapper .category-name, .topic-category .badge-category');
    if (el) return el.textContent.trim();
    const breadcrumb = document.querySelector('.category-breadcrumb .badge-category');
    if (breadcrumb) return breadcrumb.textContent.trim();
    return '';
  }

  function extractCategoryColor() {
    const el = document.querySelector('.topic-category .badge-wrapper, .category-breadcrumb .badge-wrapper');
    if (el) {
      const style = el.style;
      return style.color || style.borderColor || '';
    }
    return '';
  }

  function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }

  async function refreshTopicIfFollowing(topicId) {
    const topics = await getCdTopics();
    const existing = topics.find(t => String(t.id) === String(topicId));
    if (!existing) return;

    try {
      const data = await fetchTopic(topicId);
      const stream = data.post_stream?.stream || [];
      const lastPostIds = stream.slice(-2);
      const posts = lastPostIds.length > 0 ? await fetchLatestPosts(topicId, lastPostIds) : [];

      existing.title = data.title || existing.title;
      existing.categoryId = data.category_id;
      existing.postsCount = data.posts_count;
      existing.highestPostNumber = data.highest_post_number;
      existing.lastPostedAt = data.last_posted_at;
      existing.latestPosts = posts.map(p => ({
        id: p.id,
        username: p.username,
        avatarTemplate: p.avatar_template,
        cooked: p.cooked,
        text: stripHtml(p.cooked).trim().slice(0, 300),
        postNumber: p.post_number,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      }));
      existing.lastKnownCount = data.posts_count;
      existing.lastFetchedAt = new Date().toISOString();
      await chrome.storage.local.set({ cd_topics: topics });
    } catch (err) {
      console.warn('[cd-content] Silent refresh failed:', err);
    }
  }

  async function onFollowClick(topicId, btn) {
    btn.disabled = true;
    btn.textContent = 'Loading...';

    try {
      const data = await fetchTopic(topicId);
      const stream = data.post_stream?.stream || [];
      const lastPostIds = stream.slice(-2);
      const posts = lastPostIds.length > 0 ? await fetchLatestPosts(topicId, lastPostIds) : [];

      const categoryName = extractCategoryName() || data.category_id?.toString() || '';
      const categoryColor = extractCategoryColor() || '';

      await saveCdTopic({
        id: topicId,
        url: window.location.href.split('?')[0],
        title: data.title,
        slug: data.slug,
        categoryId: data.category_id,
        categoryName,
        categoryColor,
        postsCount: data.posts_count,
        highestPostNumber: data.highest_post_number,
        lastPostedAt: data.last_posted_at,
        addedAt: new Date().toISOString(),
        lastKnownCount: data.posts_count,
        latestPosts: posts.map(p => ({
          id: p.id,
          username: p.username,
          avatarTemplate: p.avatar_template,
          cooked: p.cooked,
          text: stripHtml(p.cooked).trim().slice(0, 300),
          postNumber: p.post_number,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        })),
        lastFetchedAt: new Date().toISOString(),
      });

      btn.innerHTML = '<svg class="cd-btn-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg> Following';
      btn.classList.add('cd-following');
      showToast('Following this topic');
    } catch (err) {
      console.error('[cd-content] Failed to follow topic:', err);
      btn.innerHTML = 'Error, retry?';
      btn.disabled = false;
    }
  }

  async function onUnfollowClick(topicId, btn) {
    btn.disabled = true;
    await removeCdTopic(topicId);
    btn.innerHTML = '<svg class="cd-btn-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg> Follow this topic';
    btn.classList.remove('cd-following');
    btn.disabled = false;
    showToast('Unfollowed');
  }

  function showToast(message) {
    let toast = document.getElementById('cd-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'cd-toast';
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #1a1613;
        color: #f8f5f0;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: 'DM Sans', sans-serif;
        font-size: 13px;
        z-index: 99999;
        opacity: 0;
        transform: translateY(12px);
        transition: opacity 0.3s, transform 0.3s;
        pointer-events: none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px)';
    }, 2500);
  }

  async function init() {
    const topicId = getTopicId();
    if (!topicId) return;

    // Silently refresh cache if already following
    refreshTopicIfFollowing(topicId);

    const topics = await getCdTopics();
    const isFollowing = topics.some(t => String(t.id) === String(topicId));

    // Create floating button
    const btn = document.createElement('button');
    btn.id = 'cd-follow-btn';
    btn.className = isFollowing ? 'cd-follow-btn cd-following' : 'cd-follow-btn';
    btn.innerHTML = isFollowing
      ? '<svg class="cd-btn-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg> Following'
      : '<svg class="cd-btn-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg> Follow this topic';
    btn.addEventListener('click', () => {
      const currentlyFollowing = btn.classList.contains('cd-following');
      if (currentlyFollowing) {
        onUnfollowClick(topicId, btn);
      } else {
        onFollowClick(topicId, btn);
      }
    });

    if (document.body) {
      document.body.appendChild(btn);
    } else {
      // SPA 导航时 body 可能暂不可见，延迟重试
      setTimeout(() => { if (document.body) document.body.appendChild(btn); }, 300);
    }
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Discourse is a SPA — re-init when navigating between topics
  let lastUrl = location.href;
  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;
    // Remove old button if present
    const oldBtn = document.getElementById('cd-follow-btn');
    if (oldBtn) oldBtn.remove();
    init();
  }

  // Watch for History API changes (Discourse uses pushState/replaceState)
  const origPush = history.pushState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    setTimeout(onUrlChange, 200);
  };
  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    setTimeout(onUrlChange, 200);
  };
  window.addEventListener('popstate', () => setTimeout(onUrlChange, 200));

  // Fallback: poll URL every 500ms (lightweight)
  setInterval(onUrlChange, 500);
})();

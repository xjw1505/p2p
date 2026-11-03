(() => {
  'use strict';

  const API_BASE = String((window.CHAT_CONFIG && window.CHAT_CONFIG.API_BASE) || '').replace(/\/$/, '');
  const CHUNK_SIZE = 24 * 1024;
  const MAX_FILE_SIZE = 64 * 1024 * 1024;
  const DB_NAME = 'room-live-chat';
  const DB_VERSION = 1;

  const $ = (id) => document.getElementById(id);
  const ui = {
    feed: $('chatFeed'), welcome: $('welcomeCard'),
    connectionDot: $('connectionDot'), connectionText: $('connectionText'), onlineCount: $('onlineCount'),
    avatar: $('myAvatar'), input: $('messageInput'), send: $('sendBtn'), attach: $('attachBtn'), fileInput: $('fileInput'),
    uploadStatus: $('uploadStatus'), uploadProgress: $('uploadProgress'), uploadLabel: $('uploadLabel'),
    toast: $('toast'), clear: $('clearHistoryBtn')
  };

  // A fresh session id prevents a later page visit from receiving messages queued
  // for a previous connection. Chat history is local; sessions are not resumed.
  let clientId = makeId();

  let nickname = 'Guest';
  let onlineMembers = [];
  let polling = false;
  let connected = false;
  let toastTimer = null;
  const transfers = new Map();
  const dbPromise = openDatabase();

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID().replace(/-/g, '');
    return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/[x]/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This browser does not support IndexedDB'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Cannot open local message database'));
    });
  }

  async function databaseRequest(mode, callback) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('messages', mode);
      const store = transaction.objectStore('messages');
      let request;
      try { request = callback(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error || new Error('Local database error'));
      transaction.onabort = () => reject(transaction.error || new Error('Local database transaction aborted'));
    });
  }

  async function saveRecord(record) {
    await databaseRequest('readwrite', (store) => store.put(record));
  }

  async function loadRecords() {
    const records = await databaseRequest('readonly', (store) => store.getAll());
    records.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
    records.forEach(renderMessage);
  }

  function setConnection(isOnline, label) {
    connected = isOnline;
    ui.connectionDot.classList.toggle('online', isOnline);
    ui.connectionText.textContent = label;
    ui.send.disabled = !isOnline;
    ui.input.disabled = !isOnline;
    ui.attach.disabled = !isOnline;
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }

  function formatTime(value) {
    const date = new Date(Number(value) || Date.now());
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function firstLetter(value) {
    const part = String(value || '?').trim().split('-').pop();
    const chars = Array.from(part || '?');
    return chars.length ? chars[0].toUpperCase() : '?';
  }

  function renderMessage(record) {
    if (!record || !record.id) return;
    if (record.type === 'system') {
      const system = document.createElement('div');
      system.className = 'system-message';
      system.textContent = record.text || '';
      ui.feed.appendChild(system);
      ui.welcome.hidden = true;
      scrollToBottom();
      return;
    }

    const row = document.createElement('article');
    row.className = 'message-row' + (record.mine ? ' mine' : '');
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = firstLetter(record.name);

    const content = document.createElement('div');
    content.className = 'message-content';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const name = document.createElement('strong');
    name.textContent = record.mine ? (record.name || nickname || '我') : (record.name || 'Guest');
    const time = document.createElement('span');
    time.textContent = formatTime(record.time);
    meta.append(name, time);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (record.type === 'file') {
      renderFileContent(bubble, record);
    } else {
      bubble.textContent = record.text || '';
    }

    content.append(meta, bubble);
    row.append(avatar, content);
    ui.feed.appendChild(row);
    ui.welcome.hidden = true;
    scrollToBottom();
  }

  function renderFileContent(container, record) {
    const blob = record.blob;
    if (!blob) {
      container.textContent = '本机没有保存这个文件';
      return;
    }
    const url = URL.createObjectURL(blob);
    if ((record.mime || blob.type || '').startsWith('image/')) {
      const link = document.createElement('a');
      link.className = 'image-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      const image = document.createElement('img');
      image.className = 'image-preview';
      image.src = url;
      image.alt = record.name || 'image';
      link.appendChild(image);
      container.appendChild(link);
    }
    const card = document.createElement('a');
    card.className = 'file-card';
    card.href = url;
    card.download = record.name || 'download';
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = (record.name || 'FILE').split('.').pop().slice(0, 5).toUpperCase();
    const info = document.createElement('div');
    info.className = 'file-info';
    const fileName = document.createElement('strong');
    fileName.textContent = record.name || 'File';
    const size = document.createElement('span');
    size.textContent = formatSize(record.size || blob.size);
    const download = document.createElement('div');
    download.className = 'file-download';
    download.textContent = '↓';
    info.append(fileName, size);
    card.append(icon, info, download);
    container.appendChild(card);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => { ui.feed.scrollTop = ui.feed.scrollHeight; });
  }

  function updateMembers(members) {
    onlineMembers = Array.isArray(members) ? members : [];
    ui.onlineCount.textContent = onlineMembers.length + ' 人在线';
  }

  async function api(path, options = {}) {
    if (!API_BASE) throw new Error('请先在 config.js 中设置 API_BASE');
    const headers = new Headers(options.headers || {});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 28000);
    try {
      const response = await fetch(API_BASE + path, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        signal: controller.signal
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text || 'Invalid server response' }; }
      if (!response.ok) {
        const error = new Error(data.error || ('HTTP ' + response.status));
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function formBody(values) {
    const body = new URLSearchParams();
    Object.keys(values).forEach((key) => body.set(key, String(values[key])));
    return body.toString();
  }

  async function postForm(path, values) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: formBody(values)
    });
  }

  async function joinRoom() {
    if (!API_BASE) throw new Error('请先在 config.js 中设置 API_BASE');
    const data = await postForm('/api/join', { id: clientId });
    nickname = data.name || 'Guest';
    ui.avatar.textContent = firstLetter(nickname);
    setConnection(true, '已连接');
  }

  async function pollLoop() {
    if (polling) return;
    polling = true;
    while (polling) {
      if (!connected) {
        clientId = makeId();
        try {
          await joinRoom();
        } catch (error) {
          setConnection(false, '连接失败，正在重试');
          await sleep(2500);
          continue;
        }
      }
      try {
        const data = await api('/api/poll?id=' + encodeURIComponent(clientId), { timeout: 26000 });
        setConnection(true, '已连接');
        updateMembers(data.online);
        for (const event of (data.events || [])) await handleEvent(event);
      } catch (error) {
        setConnection(false, '连接中断，正在重试');
        // A new session prevents messages sent while disconnected from being replayed.
        await sleep(1800);
      }
    }
  }

  async function handleEvent(event) {
    if (event.type === 'system') {
      const record = { id: event.id || makeId(), type: 'system', text: event.text || '', time: event.time || Date.now() };
      await saveRecord(record);
      renderMessage(record);
      return;
    }
    if (event.type === 'text') {
      const record = {
        id: event.id, type: 'text', name: event.name, text: event.text,
        time: event.time || Date.now(), mine: false
      };
      await saveRecord(record);
      renderMessage(record);
      return;
    }
    if (event.type === 'file_start') {
      const transferState = {
        meta: event,
        chunks: new Array(Number(event.chunks)),
        received: 0,
        cleanupTimer: null
      };
      transferState.cleanupTimer = setTimeout(() => {
        if (transfers.has(event.transfer)) {
          transfers.delete(event.transfer);
          removeTransferNotice(event.transfer);
          showToast('文件接收超时：' + event.name);
        }
      }, 5 * 60 * 1000);
      transfers.set(event.transfer, transferState);
      addTransferNotice(event.transfer, event.name, 0, Number(event.chunks));
      return;
    }
    if (event.type === 'file_chunk') {
      const transfer = transfers.get(event.transfer);
      if (!transfer || transfer.chunks[event.index]) return;
      const binary = atob(event.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      transfer.chunks[event.index] = bytes;
      transfer.received++;
      updateTransferNotice(event.transfer, transfer.received, transfer.chunks.length);
      return;
    }
    if (event.type === 'file_end') {
      const transfer = transfers.get(event.transfer);
      if (!transfer) return;
      transfers.delete(event.transfer);
      clearTimeout(transfer.cleanupTimer);
      removeTransferNotice(event.transfer);
      if (transfer.received !== transfer.chunks.length || transfer.chunks.some((chunk) => !chunk)) {
        showToast('文件传输不完整：' + transfer.meta.name);
        return;
      }
      const meta = transfer.meta;
      const blob = new Blob(transfer.chunks, { type: meta.mime || 'application/octet-stream' });
      const record = {
        id: event.transfer, type: 'file', name: meta.name, mime: meta.mime,
        size: meta.size, blob, time: meta.time || Date.now(), mine: false
      };
      await saveRecord(record);
      renderMessage(record);
    }
  }

  function addTransferNotice(id, name, received, total) {
    const notice = document.createElement('div');
    notice.className = 'transfer-notice';
    notice.id = 'transfer-' + id;
    notice.textContent = (name || '文件') + ' 正在接收 ' + received + '/' + total;
    const progress = document.createElement('progress');
    progress.max = total || 1;
    progress.value = received;
    notice.appendChild(progress);
    ui.feed.appendChild(notice);
    ui.welcome.hidden = true;
    scrollToBottom();
  }

  function updateTransferNotice(id, received, total) {
    const notice = $('transfer-' + id);
    if (!notice) return;
    const progress = notice.querySelector('progress');
    if (progress) progress.value = received;
    notice.firstChild.textContent = notice.firstChild.textContent.replace(/\s+正在接收\s+\d+\/\d+$/, ' 正在接收 ' + received + '/' + total);
  }

  function removeTransferNotice(id) {
    const notice = $('transfer-' + id);
    if (notice) notice.remove();
  }

  async function sendText() {
    const text = ui.input.value.trim();
    if (!text || !connected) return;
    ui.send.disabled = true;
    try {
      const id = makeId();
      const response = await postForm('/api/message', { client: clientId, message: id, text });
      const record = { id, type: 'text', name: nickname, text, time: response.time || Date.now(), mine: true };
      await saveRecord(record);
      renderMessage(record);
      ui.input.value = '';
      resizeInput();
    } catch (error) {
      showToast('发送失败：' + error.message);
    } finally {
      ui.send.disabled = !connected;
      ui.input.focus();
    }
  }

  async function sendFile(file) {
    if (!connected) throw new Error('当前未连接');
    if (file.size <= 0) throw new Error('不能发送空文件');
    if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 64 MB 限制');
    if (onlineMembers.filter((member) => member.id !== clientId).length === 0) {
      throw new Error('目前没有其他在线成员');
    }

    const transferId = makeId();
    const chunks = Math.ceil(file.size / CHUNK_SIZE);
    const mime = file.type || 'application/octet-stream';
    await postForm('/api/file/start', {
      client: clientId, transfer: transferId, name: file.name,
      mime, size: file.size, chunks
    });

    ui.uploadStatus.hidden = false;
    ui.uploadProgress.style.width = '0%';
    ui.uploadLabel.textContent = '正在发送 ' + file.name;

    for (let index = 0; index < chunks; index++) {
      const start = index * CHUNK_SIZE;
      const buffer = await file.slice(start, Math.min(file.size, start + CHUNK_SIZE)).arrayBuffer();
      const url = '/api/file/chunk?client=' + encodeURIComponent(clientId)
        + '&transfer=' + encodeURIComponent(transferId) + '&index=' + index;
      await retryChunk(url, buffer);
      ui.uploadProgress.style.width = Math.round(((index + 1) / chunks) * 100) + '%';
      ui.uploadLabel.textContent = '正在发送 ' + file.name + ' · ' + Math.round(((index + 1) / chunks) * 100) + '%';
    }

    await retryForm('/api/file/end', { client: clientId, transfer: transferId });
    const record = {
      id: transferId, type: 'file', name: file.name, mime,
      size: file.size, blob: file.slice(0, file.size, mime), time: Date.now(), mine: true
    };
    await saveRecord(record);
    renderMessage(record);
    ui.uploadStatus.hidden = true;
  }

  async function retryChunk(url, buffer) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const data = await api(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer,
          timeout: 30000
        });
        return data;
      } catch (error) {
        lastError = error;
        if (error.status && error.status !== 429 && error.status < 500) throw error;
        await sleep(Math.min(1500, 180 + attempt * 70));
      }
    }
    throw lastError || new Error('文件分块发送失败');
  }

  async function retryForm(path, values) {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return await postForm(path, values); }
      catch (error) {
        lastError = error;
        if (error.status && error.status !== 429 && error.status < 500) throw error;
        await sleep(Math.min(1200, 200 + attempt * 60));
      }
    }
    throw lastError || new Error('请求失败');
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function resizeInput() {
    ui.input.style.height = 'auto';
    ui.input.style.height = Math.min(ui.input.scrollHeight, 130) + 'px';
  }

  ui.send.addEventListener('click', sendText);
  ui.input.addEventListener('input', resizeInput);
  ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendText();
    }
  });

  ui.attach.addEventListener('click', () => ui.fileInput.click());
  ui.fileInput.addEventListener('change', async () => {
    const files = Array.from(ui.fileInput.files || []);
    ui.fileInput.value = '';
    for (const file of files) {
      try { await sendFile(file); }
      catch (error) { ui.uploadStatus.hidden = true; showToast(file.name + '：' + error.message); break; }
    }
  });

  ui.clear.addEventListener('click', async () => {
    if (!window.confirm('确定清空这台设备保存的全部聊天记录和文件吗？')) return;
    try {
      await databaseRequest('readwrite', (store) => store.clear());
      ui.feed.querySelectorAll('.message-row,.system-message,.transfer-notice').forEach((node) => node.remove());
      ui.welcome.hidden = false;
      showToast('本机聊天记录已清空');
    } catch (error) {
      showToast('清理失败：' + error.message);
    }
  });

  async function initialize() {
    try {
      await loadRecords();
    } catch (error) {
      showToast('本地记录功能不可用：' + error.message);
    }

    setConnection(false, '正在加入公共群聊…');
    pollLoop();
  }

  window.addEventListener('beforeunload', () => { polling = false; });
  initialize();
})();

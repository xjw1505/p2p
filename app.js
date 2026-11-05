(() => {
  'use strict';

  const APP_ID = 'xjw1505.p2p';
  const ROOM_ID = 'xjw1505-global-room-v1';
  const TRYSTERO_URLS = [
    'https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm',
    'https://esm.sh/trystero@0.26.0',
    'https://esm.run/trystero@0.26.0'
  ];
  const MAX_FILE_SIZE = 64 * 1024 * 1024;
  const MAX_RECEIVE_BYTES = 128 * 1024 * 1024;
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

  let nickname = 'Guest';
  let room = null;
  let roomReady = false;
  let connected = false;
  let toastTimer = null;
  let profileAction = null;
  let messageAction = null;
  let fileAction = null;

  const peerIds = new Set();
  const peerNames = new Map();
  const renderedIds = new Set();
  const transferNotices = new Map();
  const dbPromise = openDatabase();

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '');
    }
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
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: 'id' });
        }
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
      try {
        request = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
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

  function refreshConnection() {
    const count = peerIds.size;
    ui.onlineCount.textContent = (count + 1) + ' 人在线';
    if (count > 0) {
      setConnection(true, 'P2P 已连接');
    } else if (roomReady) {
      setConnection(false, '已加入房间，等待其他成员…');
    } else {
      setConnection(false, '正在连接公共信令…');
    }
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3000);
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
    if (!record || !record.id || renderedIds.has(record.id)) return;
    renderedIds.add(record.id);

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

  function updateOnlineMembers() {
    ui.onlineCount.textContent = (peerIds.size + 1) + ' 人在线';
  }

  function addTransferNotice(key, name, percent) {
    let noticeState = transferNotices.get(key);
    if (!noticeState) {
      const notice = document.createElement('div');
      notice.className = 'transfer-notice';
      const label = document.createElement('span');
      label.textContent = (name || '文件') + ' 正在接收';
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = 0;
      notice.append(label, progress);
      ui.feed.appendChild(notice);
      noticeState = { notice, label, progress };
      transferNotices.set(key, noticeState);
      ui.welcome.hidden = true;
      scrollToBottom();
    }
    noticeState.progress.value = Math.max(0, Math.min(100, Math.round(percent * 100)));
    noticeState.label.textContent = (name || '文件') + ' 正在接收 ' + noticeState.progress.value + '%';
  }

  function removeTransferNotice(key) {
    const noticeState = transferNotices.get(key);
    if (!noticeState) return;
    noticeState.notice.remove();
    transferNotices.delete(key);
  }

  function transferKey(peerId, metadata) {
    return String(peerId) + ':' + String((metadata && metadata.transferId) || 'unknown');
  }

  async function dataToArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (data instanceof Blob) return data.arrayBuffer();
    throw new Error('收到未知的文件数据格式');
  }

  function setupActions() {
    profileAction = room.makeAction('profile-v1');
    messageAction = room.makeAction('chat-message-v1');
    fileAction = room.makeAction('chat-file-v1');

    profileAction.onMessage = (data, context) => {
      if (!context || !context.peerId || !data || typeof data.name !== 'string') return;
      peerNames.set(context.peerId, data.name.slice(0, 32));
    };

    messageAction.onMessage = async (data, context) => {
      if (!data || typeof data !== 'object' || !data.id || typeof data.text !== 'string') return;
      if (data.text.length > 8000 || renderedIds.has(data.id)) return;
      const record = {
        id: String(data.id),
        type: 'text',
        name: String(data.name || peerNames.get(context.peerId) || 'Guest').slice(0, 32),
        text: data.text,
        time: Number(data.time) || Date.now(),
        mine: false
      };
      try {
        await saveRecord(record);
        renderMessage(record);
      } catch (error) {
        showToast('保存消息失败：' + error.message);
      }
    };

    fileAction.onReceive = ({ byteLength, metadata }) => {
      const size = Number(metadata && metadata.size) || Number(byteLength) || 0;
      return size > 0 && size <= MAX_FILE_SIZE;
    };

    fileAction.onReceiveProgress = (percent, context) => {
      const metadata = context.metadata || {};
      addTransferNotice(transferKey(context.peerId, metadata), metadata.name, percent);
    };

    fileAction.onMessage = async (data, context) => {
      const metadata = context.metadata || {};
      const key = transferKey(context.peerId, metadata);
      removeTransferNotice(key);
      try {
        const buffer = await dataToArrayBuffer(data);
        const mime = String(metadata.mime || metadata.type || 'application/octet-stream');
        const blob = new Blob([buffer], { type: mime });
        if (blob.size > MAX_FILE_SIZE) throw new Error('文件超过 64 MB 限制');
        const record = {
          id: String(metadata.transferId || makeId()),
          type: 'file',
          name: String(metadata.name || 'download'),
          mime,
          size: Number(metadata.size) || blob.size,
          blob,
          time: Number(metadata.time) || Date.now(),
          mine: false
        };
        await saveRecord(record);
        renderMessage(record);
      } catch (error) {
        showToast('文件接收失败：' + error.message);
      }
    };
  }

  async function loadTrystero() {
    let lastError;
    for (const url of TRYSTERO_URLS) {
      try {
        const module = await import(url);
        if (typeof module.joinRoom === 'function') return module;
        throw new Error('模块中没有找到 joinRoom');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('无法加载 Trystero');
  }

  async function connectP2P() {
    const trystero = await loadTrystero();

    const id = String(trystero.selfId || makeId());
    nickname = 'Guest-' + id.slice(0, 5).toUpperCase();
    ui.avatar.textContent = firstLetter(nickname);

    room = trystero.joinRoom({
      appId: APP_ID,
      maxReceiveBytes: MAX_RECEIVE_BYTES
    }, ROOM_ID, {
      onJoinError: (details) => {
        const message = details && details.error && details.error.message
          ? details.error.message
          : '无法建立 P2P 连接';
        if (details && details.peerId) peerIds.delete(details.peerId);
        refreshConnection();
        showToast('P2P 连接失败：' + message);
      }
    });

    setupActions();
    roomReady = true;

    room.onPeerJoin = (peerId) => {
      peerIds.add(peerId);
      peerNames.set(peerId, peerNames.get(peerId) || 'Guest');
      updateOnlineMembers();
      refreshConnection();
      profileAction.send({ name: nickname }, { target: peerId });
    };

    room.onPeerLeave = (peerId) => {
      peerIds.delete(peerId);
      peerNames.delete(peerId);
      updateOnlineMembers();
      refreshConnection();
    };

    refreshConnection();
  }

  async function sendText() {
    const text = ui.input.value.trim();
    if (!text || !connected || !messageAction) return;
    ui.send.disabled = true;
    try {
      const record = {
        id: makeId(),
        type: 'text',
        name: nickname,
        text,
        time: Date.now(),
        mine: true
      };
      await messageAction.send({
        id: record.id,
        name: record.name,
        text: record.text,
        time: record.time
      });
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
    if (!connected || !fileAction) throw new Error('当前没有 P2P 对端');
    if (file.size <= 0) throw new Error('不能发送空文件');
    if (file.size > MAX_FILE_SIZE) throw new Error('文件超过 64 MB 限制');
    if (peerIds.size === 0) throw new Error('目前没有其他在线成员');

    const transferId = makeId();
    const mime = file.type || 'application/octet-stream';
    const progressByPeer = new Map(Array.from(peerIds, (peerId) => [peerId, 0]));

    ui.uploadStatus.hidden = false;
    ui.uploadProgress.style.width = '0%';
    ui.uploadLabel.textContent = '正在 P2P 发送 ' + file.name;

    await fileAction.send(file, {
      metadata: {
        transferId,
        name: file.name,
        mime,
        size: file.size,
        time: Date.now()
      },
      onProgress: (percent, context) => {
        if (context && context.peerId) progressByPeer.set(context.peerId, percent);
        const values = Array.from(progressByPeer.values());
        const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : percent;
        const done = Math.round(average * 100);
        ui.uploadProgress.style.width = done + '%';
        ui.uploadLabel.textContent = '正在 P2P 发送 ' + file.name + ' · ' + done + '%';
      }
    });

    const record = {
      id: transferId,
      type: 'file',
      name: file.name,
      mime,
      size: file.size,
      blob: file.slice(0, file.size, mime),
      time: Date.now(),
      mine: true
    };
    await saveRecord(record);
    renderMessage(record);
    ui.uploadProgress.style.width = '100%';
    ui.uploadLabel.textContent = 'P2P 发送完成：' + file.name;
    await sleep(600);
    ui.uploadStatus.hidden = true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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
      try {
        await sendFile(file);
      } catch (error) {
        ui.uploadStatus.hidden = true;
        showToast(file.name + '：' + error.message);
        break;
      }
    }
  });

  ui.clear.addEventListener('click', async () => {
    if (!window.confirm('确定清空这台设备保存的全部聊天记录和文件吗？')) return;
    try {
      await databaseRequest('readwrite', (store) => store.clear());
      renderedIds.clear();
      ui.feed.querySelectorAll('.message-row,.system-message,.transfer-notice').forEach((node) => node.remove());
      transferNotices.clear();
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

    setConnection(false, '正在加载 P2P 模块…');
    while (!room) {
      try {
        await connectP2P();
      } catch (error) {
        roomReady = false;
        setConnection(false, 'P2P 初始化失败，正在重试…');
        showToast('P2P 初始化失败：' + error.message);
        await sleep(5000);
      }
    }
  }

  window.addEventListener('online', () => {
    if (!roomReady) setConnection(false, '网络已恢复，正在连接…');
  });
  window.addEventListener('beforeunload', () => {
    if (room && typeof room.leave === 'function') room.leave();
  });

  initialize();
})();

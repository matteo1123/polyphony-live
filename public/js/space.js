document.addEventListener('DOMContentLoaded', () => {
  // Extract space ID from URL
  const pathParts = window.location.pathname.split('/');
  const spaceId = pathParts[pathParts.length - 1];

  if (!spaceId) {
    alert('Invalid space URL');
    window.location.href = '/';
    return;
  }

  // User identity
  const userId = localStorage.getItem('polyphony_user_id') || `user-${Math.random().toString(36).substr(2, 9)}`;
  localStorage.setItem('polyphony_user_id', userId);

  let userName = localStorage.getItem('polyphony_user_name') || '';
  let isAdmin = false;
  let groupChatEnabled = false;

  // Elements
  const nameModal = document.getElementById('nameModal');
  const nameInput = document.getElementById('nameInput');
  const joinBtn = document.getElementById('joinBtn');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const userCount = document.getElementById('userCount');
  const adminControls = document.getElementById('adminControls');
  const groupChatToggle = document.getElementById('groupChatToggle');
  const chatModeLabel = document.getElementById('chatModeLabel');
  const knowledgeTree = document.getElementById('knowledgeTree');
  const knowledgeSidebar = document.getElementById('knowledgeSidebar');
  const toggleSidebar = document.getElementById('toggleSidebar');
  const sharedCanvas = document.getElementById('sharedCanvas');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const uploadBtn = document.getElementById('uploadBtn');
  const fileInput = document.getElementById('fileInput');
  const exportBtn = document.getElementById('exportBtn');

  // Visualization renderer
  const vizRenderer = new VisualizationRenderer('sharedCanvas');

  // Chat history (client-side only - private chat)
  let conversationHistory = [];
  let pendingMessage = null;

  // Socket connection
  let socket = null;

  // Show name modal if no name stored
  if (!userName) {
    nameModal.classList.remove('hidden');
    nameInput.focus();
  } else {
    nameModal.classList.add('hidden');
    initializeSocket();
  }

  // Name modal handlers
  joinBtn.addEventListener('click', handleJoin);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoin();
  });

  function handleJoin() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    userName = name;
    localStorage.setItem('polyphony_user_name', userName);
    nameModal.classList.add('hidden');
    initializeSocket();
  }

  function initializeSocket() {
    socket = io({ transports: ['websocket', 'polling'] });
    setupSocketHandlers();
  }

  function setupSocketHandlers() {
    socket.on('connect', () => {
      statusDot.className = 'status-dot connected';
      statusText.textContent = 'Connected';
      socket.emit('room:join', {
        roomId: spaceId,
        userId: userId,
        userName: userName
      });
    });

    socket.on('disconnect', () => {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Disconnected';
    });

    socket.on('connect_error', () => {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Connection Error';
    });

    // Room joined - receive initial state
    socket.on('room:joined', (data) => {
      console.log('Joined room:', data);
      isAdmin = data.isAdmin;
      groupChatEnabled = data.settings?.groupChatEnabled || false;

      // Show admin controls if admin
      if (isAdmin) {
        adminControls.classList.remove('hidden');
        groupChatToggle.checked = groupChatEnabled;
      }

      updateChatMode();

      // Render existing canvas
      if (data.canvas && data.canvas.length > 0) {
        renderCanvas(data.canvas);
      }

      addSystemMessage(`Welcome, ${userName}!${isAdmin ? ' (Admin)' : ''}`);
    });

    socket.on('room:user_joined', (data) => {
      if (data.userId !== userId) {
        addSystemMessage(`${data.userName} joined`);
      }
      updateUserCount(data.activeUsers);
    });

    socket.on('room:user_left', (data) => {
      addSystemMessage(`${data.userName} left`);
      updateUserCount(data.activeUsers);
    });

    socket.on('room:active_users', (data) => {
      updateUserCount(data.count);
    });

    // Message ACK
    socket.on('message:ack', () => {
      if (pendingMessage) {
        chatInput.value = '';
        pendingMessage = null;
      }
    });

    // Agent response (private)
    socket.on('agent:response', (data) => {
      addMessage('Agent', data.content, 'agent');
      conversationHistory.push({ role: 'assistant', content: data.content });
    });

    socket.on('agent:typing', showTypingIndicator);
    socket.on('agent:done', hideTypingIndicator);

    // Canvas updates (public)
    socket.on('canvas:update', (data) => {
      addCanvasItem(data.contribution);
    });

    // Knowledge tree updates
    socket.on('knowledge:update', (data) => {
      updateKnowledgeTree(data);
    });

    // Visualization (private)
    socket.on('visualization:render', (data) => {
      vizRenderer.render(data);
    });

    // Settings updates
    socket.on('settings:updated', (data) => {
      groupChatEnabled = data.settings.groupChatEnabled;
      groupChatToggle.checked = groupChatEnabled;
      updateChatMode();
      addSystemMessage(`${data.changedBy} ${groupChatEnabled ? 'enabled' : 'disabled'} group chat`);
    });

    // File events
    socket.on('file:processing', (data) => {
      addSystemMessage(`Processing ${data.fileName}...`);
    });

    socket.on('file:processed', (data) => {
      const isOwn = data.userId === userId;
      addSystemMessage(isOwn
        ? `Your file "${data.fileName}" processed`
        : `${data.userName} uploaded "${data.fileName}"`
      );
    });

    socket.on('file:error', (data) => {
      addSystemMessage(`Error: ${data.error}`, 'error');
    });

    socket.on('export:ready', (data) => {
      downloadMarkdown(data.markdown, data.fileName);
    });

    socket.on('error', (data) => {
      console.error('Socket error:', data);
      addSystemMessage(`Error: ${data.message}`, 'error');
    });

    // Heartbeat
    setInterval(() => {
      if (socket?.connected) {
        socket.emit('heartbeat', { roomId: spaceId, userId });
      }
    }, 30000);
  }

  // Admin: toggle group chat
  groupChatToggle.addEventListener('change', () => {
    socket.emit('settings:set', { groupChatEnabled: groupChatToggle.checked });
  });

  function updateChatMode() {
    if (groupChatEnabled) {
      chatModeLabel.textContent = 'Group Chat (visible to all)';
      chatModeLabel.classList.add('group-chat');
      chatInput.placeholder = 'Message everyone...';
    } else {
      chatModeLabel.textContent = 'Private chat with Agent';
      chatModeLabel.classList.remove('group-chat');
      chatInput.placeholder = 'Share your thoughts honestly...';
    }
  }

  // Send message
  function sendMessage() {
    const content = chatInput.value.trim();
    if (!content || !socket || pendingMessage) return;

    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    pendingMessage = { messageId, content };
    conversationHistory.push({ role: 'user', content });

    addMessage('You', content, 'user', true);

    socket.emit('message:send', {
      content,
      messageId,
      conversationHistory
    });

    chatInput.focus();
  }

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
  });

  // File upload
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    fileInput.value = '';
  });

  function handleFiles(files) {
    for (const file of files) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!['.pdf', '.docx', '.txt', '.md'].includes(ext)) {
        addSystemMessage(`Unsupported: ${ext}`, 'error');
        continue;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        socket.emit('file:upload', {
          fileName: file.name,
          fileType: ext,
          content: e.target.result
        });
      };

      if (ext === '.txt' || ext === '.md') {
        reader.readAsText(file);
      } else {
        reader.readAsArrayBuffer(file);
      }
    }
  }

  exportBtn.addEventListener('click', () => {
    socket.emit('export:request', { roomId: spaceId });
    addSystemMessage('Generating export...');
  });

  toggleSidebar.addEventListener('click', () => {
    knowledgeSidebar.classList.toggle('collapsed');
    const icon = toggleSidebar.querySelector('.toggle-icon');
    icon.textContent = knowledgeSidebar.classList.contains('collapsed') ? '\u25C0' : '\u25B6';
  });

  // Canvas rendering
  function renderCanvas(canvas) {
    sharedCanvas.innerHTML = '';
    for (const item of canvas) {
      addCanvasItem(item, false);
    }
  }

  function addCanvasItem(item, scroll = true) {
    // Remove placeholder if present
    const placeholder = sharedCanvas.querySelector('.canvas-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = `canvas-item ${item.type}`;
    div.dataset.id = item.id;

    const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
      <div class="canvas-item-header">
        <span class="canvas-item-type">${item.type}</span>
        <span class="canvas-item-user">${item.userName}</span>
      </div>
      <div class="canvas-item-content">${escapeHtml(item.content)}</div>
      <div class="canvas-item-time">${time}</div>
    `;

    sharedCanvas.appendChild(div);
    if (scroll) sharedCanvas.scrollTop = sharedCanvas.scrollHeight;
  }

  // UI helpers
  function addMessage(sender, content, type, isOwn = false) {
    const div = document.createElement('div');
    div.className = `message ${type}${isOwn ? ' own' : ''}`;

    div.innerHTML = `
      <div class="sender">${sender}</div>
      <div class="content">${escapeHtml(content)}</div>
    `;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function addSystemMessage(content, type = 'info') {
    const div = document.createElement('div');
    div.className = `message system ${type}`;
    div.textContent = content;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function updateUserCount(count) {
    userCount.textContent = `${count} user${count !== 1 ? 's' : ''}`;
  }

  function updateKnowledgeTree(data) {
    if (!data?.topics?.length) {
      knowledgeTree.innerHTML = '<p class="empty">No knowledge entries yet.</p>';
      return;
    }

    knowledgeTree.innerHTML = '';
    for (const topic of data.topics) {
      knowledgeTree.appendChild(createTopicNode(topic));
    }
  }

  function createTopicNode(topic) {
    const div = document.createElement('div');
    div.className = 'topic-node';

    const header = document.createElement('div');
    header.className = 'topic-header';

    const toggle = document.createElement('span');
    toggle.className = 'topic-toggle';
    toggle.textContent = topic.children ? '\u25BC' : '\u2022';

    const title = document.createElement('span');
    title.className = 'topic-title';
    title.textContent = topic.title;

    if (topic.badge) {
      const badge = document.createElement('span');
      badge.className = 'topic-badge';
      badge.textContent = topic.badge;
      header.appendChild(badge);
    }

    header.appendChild(toggle);
    header.appendChild(title);
    div.appendChild(header);

    if (topic.content || topic.children) {
      const content = document.createElement('div');
      content.className = 'topic-content';

      if (topic.content) {
        const p = document.createElement('p');
        p.textContent = topic.content;
        content.appendChild(p);
      }

      if (topic.children) {
        for (const child of topic.children) {
          content.appendChild(createTopicNode(child));
        }
      }

      div.appendChild(content);
      header.addEventListener('click', () => {
        content.classList.toggle('collapsed');
        toggle.textContent = content.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
      });
    }

    return div;
  }

  let typingIndicator = null;

  function showTypingIndicator() {
    if (typingIndicator) return;
    typingIndicator = document.createElement('div');
    typingIndicator.className = 'message agent typing';
    typingIndicator.innerHTML = '<div class="spinner"></div>';
    chatMessages.appendChild(typingIndicator);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function hideTypingIndicator() {
    if (typingIndicator) {
      typingIndicator.remove();
      typingIndicator = null;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function downloadMarkdown(content, fileName) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'polyphony-export.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addSystemMessage('Export downloaded!');
  }
});

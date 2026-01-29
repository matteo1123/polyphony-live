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

  // ═══════════════════════════════════════════════════════════════════════════
  // VIEW TOGGLE & VECTOR CLOUD VISUALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  // View toggle elements
  const canvasViewBtn = document.getElementById('canvasViewBtn');
  const vectorCloudViewBtn = document.getElementById('vectorCloudViewBtn');
  const canvasArea = document.getElementById('canvasArea');
  const vectorCloudArea = document.getElementById('vectorCloudArea');
  
  let currentView = 'canvas';
  let vectorCloudData = [];
  let vectorCloud = null;

  // View toggle handlers
  canvasViewBtn.addEventListener('click', () => {
    if (currentView !== 'canvas') {
      currentView = 'canvas';
      canvasViewBtn.classList.add('active');
      vectorCloudViewBtn.classList.remove('active');
      canvasArea.classList.remove('hidden');
      vectorCloudArea.classList.add('hidden');
    }
  });

  vectorCloudViewBtn.addEventListener('click', () => {
    if (currentView !== 'vector') {
      currentView = 'vector';
      vectorCloudViewBtn.classList.add('active');
      canvasViewBtn.classList.remove('active');
      vectorCloudArea.classList.remove('hidden');
      canvasArea.classList.add('hidden');
      
      // Initialize or refresh vector cloud
      if (!vectorCloud) {
        initVectorCloud();
      }
      requestVectorData();
    }
  });

  // Vector Cloud Visualization Class
  class VectorCloudVisualizer {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.container = this.canvas.parentElement;
      this.ctx = this.canvas.getContext('2d');
      this.points = [];
      this.clusters = new Map();
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.isDragging = false;
      this.lastX = 0;
      this.lastY = 0;
      this.hoveredPoint = null;
      this.showLabels = false;
      
      // Color palette for clusters
      this.colors = [
        '#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4',
        '#8b5cf6', '#ef4444', '#84cc16', '#f97316', '#14b8a6'
      ];
      
      this.resize();
      this.setupEvents();
      this.animate();
    }

    resize() {
      const rect = this.container.getBoundingClientRect();
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      this.centerX = this.canvas.width / 2;
      this.centerY = this.canvas.height / 2;
    }

    setupEvents() {
      // Mouse interactions
      this.canvas.addEventListener('mousedown', (e) => {
        this.isDragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      });

      window.addEventListener('mousemove', (e) => {
        if (this.isDragging) {
          const dx = e.clientX - this.lastX;
          const dy = e.clientY - this.lastY;
          this.offsetX += dx;
          this.offsetY += dy;
          this.lastX = e.clientX;
          this.lastY = e.clientY;
        }
        this.updateHover(e);
      });

      window.addEventListener('mouseup', () => {
        this.isDragging = false;
      });

      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        this.scale *= zoomFactor;
        this.scale = Math.max(0.1, Math.min(5, this.scale));
      });

      window.addEventListener('resize', () => this.resize());
    }

    updateHover(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - this.offsetX - this.centerX) / this.scale;
      const y = (e.clientY - rect.top - this.offsetY - this.centerY) / this.scale;
      
      let closest = null;
      let closestDist = 20; // Hover radius

      for (const point of this.points) {
        const dx = point.x - x;
        const dy = point.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist) {
          closestDist = dist;
          closest = point;
        }
      }

      this.hoveredPoint = closest;
      this.updateTooltip(e.clientX, e.clientY);
    }

    updateTooltip(mouseX, mouseY) {
      const tooltip = document.getElementById('vectorTooltip');
      
      if (this.hoveredPoint) {
        tooltip.classList.remove('hidden');
        tooltip.style.left = (mouseX + 15) + 'px';
        tooltip.style.top = (mouseY + 15) + 'px';
        
        document.getElementById('tooltipTitle').textContent = this.hoveredPoint.topic;
        document.getElementById('tooltipContent').textContent = 
          this.hoveredPoint.content.slice(0, 150) + '...';
        document.getElementById('tooltipSimilarity').textContent = 
          `Cluster: ${this.hoveredPoint.cluster}`;
      } else {
        tooltip.classList.add('hidden');
      }
    }

    setData(points) {
      // Project high-dimensional vectors to 2D using simple PCA-like approach
      this.points = this.projectTo2D(points);
      this.detectClusters();
      this.updateLegend();
      this.updateStats();
      
      // Auto-center
      if (this.points.length > 0) {
        const bounds = this.getBounds();
        this.offsetX = this.centerX - (bounds.minX + bounds.maxX) / 2 * this.scale;
        this.offsetY = this.centerY - (bounds.minY + bounds.maxY) / 2 * this.scale;
      }
    }

    projectTo2D(points) {
      // Simple force-directed layout for visualization
      // In a real implementation, you'd use t-SNE or UMAP on the server
      const projected = [];
      
      // Group by tags for clustering
      const tagGroups = new Map();
      points.forEach((p, i) => {
        const tag = p.tags?.[0] || 'uncategorized';
        if (!tagGroups.has(tag)) tagGroups.set(tag, []);
        tagGroups.get(tag).push({ ...p, index: i });
      });

      // Arrange clusters in a circle
      const clusterCount = tagGroups.size;
      const clusterRadius = 200;
      let clusterIdx = 0;

      for (const [tag, groupPoints] of tagGroups) {
        const angle = (clusterIdx / clusterCount) * Math.PI * 2;
        const cx = Math.cos(angle) * clusterRadius;
        const cy = Math.sin(angle) * clusterRadius;

        // Arrange points within cluster
        groupPoints.forEach((p, i) => {
          const spread = 80;
          const px = cx + (Math.random() - 0.5) * spread + Math.cos(i * 0.5) * 30;
          const py = cy + (Math.random() - 0.5) * spread + Math.sin(i * 0.5) * 30;
          
          projected.push({
            ...p,
            x: px,
            y: py,
            cluster: tag,
            color: this.colors[clusterIdx % this.colors.length]
          });
        });

        clusterIdx++;
      }

      return projected;
    }

    detectClusters() {
      this.clusters.clear();
      for (const point of this.points) {
        if (!this.clusters.has(point.cluster)) {
          this.clusters.set(point.cluster, {
            color: point.color,
            count: 0
          });
        }
        this.clusters.get(point.cluster).count++;
      }
    }

    updateLegend() {
      const legendContent = document.getElementById('legendContent');
      legendContent.innerHTML = '';
      
      for (const [name, info] of this.clusters) {
        const item = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `
          <span class="legend-color" style="background: ${info.color}"></span>
          <span>${name} (${info.count})</span>
        `;
        legendContent.appendChild(item);
      }
    }

    updateStats() {
      document.getElementById('vectorCount').textContent = this.points.length;
      document.getElementById('clusterCount').textContent = this.clusters.size;
    }

    getBounds() {
      if (this.points.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
      
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      
      for (const p of this.points) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      
      return { minX, maxX, minY, maxY };
    }

    resetView() {
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
    }

    toggleLabels() {
      this.showLabels = !this.showLabels;
    }

    animate() {
      this.draw();
      requestAnimationFrame(() => this.animate());
    }

    draw() {
      // Clear canvas
      this.ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--bg-primary');
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      this.ctx.save();
      
      // Apply transforms
      this.ctx.translate(this.offsetX + this.centerX, this.offsetY + this.centerY);
      this.ctx.scale(this.scale, this.scale);

      // Draw connection lines for same cluster
      this.ctx.strokeStyle = 'rgba(99, 102, 241, 0.1)';
      this.ctx.lineWidth = 1 / this.scale;
      
      for (let i = 0; i < this.points.length; i++) {
        for (let j = i + 1; j < this.points.length; j++) {
          const p1 = this.points[i];
          const p2 = this.points[j];
          if (p1.cluster === p2.cluster) {
            this.ctx.beginPath();
            this.ctx.moveTo(p1.x, p1.y);
            this.ctx.lineTo(p2.x, p2.y);
            this.ctx.stroke();
          }
        }
      }

      // Draw points
      for (const point of this.points) {
        const isHovered = point === this.hoveredPoint;
        const radius = isHovered ? 8 : 5;
        
        // Glow effect for hovered point
        if (isHovered) {
          this.ctx.beginPath();
          this.ctx.arc(point.x, point.y, radius * 2, 0, Math.PI * 2);
          this.ctx.fillStyle = point.color + '40';
          this.ctx.fill();
        }
        
        // Main point
        this.ctx.beginPath();
        this.ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        this.ctx.fillStyle = point.color;
        this.ctx.fill();
        
        // Border
        this.ctx.strokeStyle = isHovered ? '#fff' : point.color;
        this.ctx.lineWidth = isHovered ? 2 / this.scale : 1 / this.scale;
        this.ctx.stroke();

        // Label
        if (this.showLabels || isHovered) {
          this.ctx.fillStyle = '#fff';
          this.ctx.font = `${12 / this.scale}px sans-serif`;
          this.ctx.fillText(point.topic.slice(0, 20), point.x + 10, point.y + 4);
        }
      }

      this.ctx.restore();
    }
  }

  // Initialize vector cloud
  function initVectorCloud() {
    vectorCloud = new VectorCloudVisualizer('vectorCloud');
    
    // Setup controls
    document.getElementById('resetZoomBtn').addEventListener('click', () => {
      vectorCloud.resetView();
    });
    
    document.getElementById('toggleLabelsBtn').addEventListener('click', (e) => {
      vectorCloud.toggleLabels();
      e.target.textContent = vectorCloud.showLabels ? 'Hide Labels' : 'Show Labels';
    });

    // Sync sidebar toggle
    document.getElementById('toggleVectorSidebar').addEventListener('click', () => {
      const sidebar = document.getElementById('vectorKnowledgeSidebar');
      sidebar.classList.toggle('collapsed');
      const icon = document.getElementById('toggleVectorSidebar').querySelector('.toggle-icon');
      icon.textContent = sidebar.classList.contains('collapsed') ? '\u25C0' : '\u25B6';
    });
  }

  // Request vector data from server
  function requestVectorData() {
    if (socket && socket.connected) {
      socket.emit('vectorcloud:request', { roomId: spaceId });
    }
  }

  // Handle vector data from server
  socket?.on('vectorcloud:data', (data) => {
    if (vectorCloud && data.points) {
      vectorCloud.setData(data.points);
    }
  });

  // Update knowledge tree in vector view when it changes
  const originalUpdateKnowledgeTree = updateKnowledgeTree;
  updateKnowledgeTree = function(data) {
    originalUpdateKnowledgeTree(data);
    
    // Also update vector view sidebar
    const vectorTree = document.getElementById('vectorKnowledgeTree');
    if (data?.topics?.length) {
      vectorTree.innerHTML = '';
      for (const topic of data.topics) {
        vectorTree.appendChild(createTopicNode(topic));
      }
    }
  };
});

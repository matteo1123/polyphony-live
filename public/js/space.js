import { VoiceChat } from './voiceChat.js';

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
  const voiceBtn = document.getElementById('voiceBtn');

  // Visualization renderer
  const vizRenderer = new VisualizationRenderer('sharedCanvas');

  // Chat history (client-side only - private chat)
  let conversationHistory = [];
  let pendingMessage = null;

  // Socket connection
  let socket = null;
  
  // Voice chat
  let voiceChat = null;
  let voiceEnabled = false;
  let agentVoiceEnabled = true; // Auto-speak agent responses
  let interimTranscriptElement = null;

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
      
      // Speak agent response if voice is enabled
      if (voiceEnabled && agentVoiceEnabled && voiceChat) {
        voiceChat.speak(data.content);
      }
    });

    socket.on('agent:typing', showTypingIndicator);
    socket.on('agent:done', hideTypingIndicator);

    // Canvas updates (public)
    socket.on('canvas:update', (data) => {
      addCanvasItem(data.contribution);
    });

    // Full canvas update (hierarchical)
    socket.on('canvas:full_update', (data) => {
      currentCanvasData = data.canvas;
      renderHierarchicalCanvas(data.canvas);
    });
    
    // Topic expansion update
    socket.on('canvas:topic_expanded', (data) => {
      addSystemMessage(`Topic "${data.topicPath[data.topicPath.length - 1]}" expanded by ${data.expandedBy}`);
      // Canvas will auto-update on next full_update
    });
    
    // Topic diagram generated
    socket.on('canvas:diagram_generated', (data) => {
      const { topicPath, diagram, requestedBy } = data;
      
      // Find the node in the current canvas
      if (currentCanvasData && currentCanvasData.hierarchy) {
        let current = currentCanvasData.hierarchy;
        let targetNode = null;
        
        // Navigate to the target node
        for (let i = 0; i < topicPath.length; i++) {
          const index = topicPath[i];
          if (i === topicPath.length - 1) {
            targetNode = current[index];
          } else {
            current = current[index]?.children || [];
          }
        }
        
        if (targetNode) {
          // Add diagram to the node's expanded content
          if (!targetNode.expandedContent) {
            targetNode.expandedContent = '';
          }
          targetNode.expandedContent += '\n\n' + diagram;
          
          // Re-render the canvas
          renderHierarchicalCanvas(currentCanvasData);
          
          // Find and show the diagram in the DOM
          setTimeout(() => {
            const hierarchyDiv = document.getElementById('hierarchyRoot');
            if (hierarchyDiv) {
              // Find the node by path
              let targetDiv = hierarchyDiv;
              for (const index of topicPath) {
                const children = targetDiv.querySelectorAll(':scope > .hierarchy-node');
                targetDiv = children[index];
                if (!targetDiv) break;
              }
              
              if (targetDiv) {
                const diagramDiv = targetDiv.querySelector('.hierarchy-diagram');
                const expandedContent = targetDiv.querySelector('.hierarchy-expanded-content');
                if (expandedContent) {
                  expandedContent.classList.remove('hidden');
                  // Re-render mermaid
                  if (window.renderMermaidBlocks) {
                    window.renderMermaidBlocks(expandedContent);
                  }
                }
              }
            }
          }, 100);
          
          addSystemMessage(`Diagram generated for "${targetNode.title}"`);
        }
      }
      
      // Remove loading state from button if this user requested it
      if (requestedBy === userId) {
        const mermaidBtns = document.querySelectorAll('.mermaid-btn.loading');
        mermaidBtns.forEach(btn => {
          btn.classList.remove('loading');
          btn.disabled = false;
        });
      }
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
    const newHeight = Math.min(chatInput.scrollHeight, 80);
    chatInput.style.height = newHeight + 'px';
    // Enable scrolling when at max height
    chatInput.style.overflowY = newHeight >= 80 ? 'auto' : 'hidden';
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

  // ═══════════════════════════════════════════════════════════════════════════
  // VOICE CHAT
  // ═══════════════════════════════════════════════════════════════════════════
  
  function initVoiceChat() {
    voiceChat = new VoiceChat({
      onTranscript: (text) => {
        // Final transcript - send as message
        removeInterimTranscript();
        sendVoiceMessage(text);
      },
      onInterimTranscript: (text) => {
        // Show interim transcript in UI
        showInterimTranscript(text);
      },
      onStart: () => {
        updateVoiceUI('listening');
      },
      onEnd: () => {
        if (voiceEnabled) {
          updateVoiceUI('enabled');
        } else {
          updateVoiceUI('disabled');
        }
      },
      onError: (error) => {
        console.error('Voice chat error:', error);
        if (error.type === 'STT_UNSUPPORTED') {
          addSystemMessage('Voice chat not supported in your browser', 'error');
          voiceEnabled = false;
          updateVoiceUI('disabled');
        }
      },
      onTTSStart: () => {
        updateVoiceUI('speaking');
      },
      onTTSEnd: () => {
        updateVoiceUI(voiceEnabled ? 'enabled' : 'disabled');
      },
      onModelLoad: (status) => {
        if (status.status === 'loaded') {
          addSystemMessage('High-quality voice model loaded');
        } else if (status.status === 'fallback') {
          console.log('Using Web Speech API for TTS');
        }
      }
    });
    
    // Check if voice is supported
    if (!voiceChat.isSupported()) {
      voiceBtn.style.display = 'none';
      console.log('Voice chat not supported in this browser');
    }
  }
  
  function sendVoiceMessage(text) {
    if (!text.trim() || !socket) return;
    
    const messageId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    pendingMessage = { messageId, content: text };
    conversationHistory.push({ role: 'user', content: text });
    
    addMessage('You', text, 'user', true);
    
    socket.emit('message:send', {
      content: text,
      messageId,
      conversationHistory
    });
    
    // Pause listening while waiting for response
    if (voiceChat) {
      voiceChat.stopListening();
    }
  }
  
  function showInterimTranscript(text) {
    if (!interimTranscriptElement) {
      interimTranscriptElement = document.createElement('div');
      interimTranscriptElement.className = 'message user own interim-transcript';
      interimTranscriptElement.innerHTML = `
        <div class="sender">You (speaking...)</div>
        <div class="content"></div>
      `;
      chatMessages.appendChild(interimTranscriptElement);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    interimTranscriptElement.querySelector('.content').textContent = text;
  }
  
  function removeInterimTranscript() {
    if (interimTranscriptElement) {
      interimTranscriptElement.remove();
      interimTranscriptElement = null;
    }
  }
  
  function updateVoiceUI(state) {
    voiceBtn.classList.remove('listening', 'speaking', 'enabled', 'loading');
    const indicator = voiceBtn.querySelector('.voice-indicator');
    const waves = voiceBtn.querySelector('.voice-waves');
    const status = voiceBtn.querySelector('.voice-status');
    
    indicator.classList.add('hidden');
    waves.classList.add('hidden');
    
    switch (state) {
      case 'listening':
        voiceBtn.classList.add('listening');
        waves.classList.remove('hidden');
        status.textContent = 'Listening';
        break;
      case 'speaking':
        voiceBtn.classList.add('speaking');
        status.textContent = 'Speaking';
        break;
      case 'loading':
        voiceBtn.classList.add('loading');
        status.textContent = 'Loading...';
        break;
      case 'enabled':
        voiceBtn.classList.add('enabled');
        indicator.classList.remove('hidden');
        status.textContent = 'Voice On';
        break;
      default:
        status.textContent = 'Voice';
    }
  }
  
  async function toggleVoiceChat() {
    if (!voiceChat) {
      initVoiceChat();
    }
    
    if (!voiceChat.isSupported()) {
      addSystemMessage('Voice chat is not supported in your browser. Please use Chrome, Edge, or Safari.', 'error');
      return;
    }
    
    if (voiceEnabled) {
      // Disable voice
      voiceEnabled = false;
      voiceChat.disableVoiceMode();
      updateVoiceUI('disabled');
      addSystemMessage('Voice chat disabled');
    } else {
      // Enable voice
      updateVoiceUI('loading');
      voiceEnabled = true;
      await voiceChat.enableVoiceMode();
      updateVoiceUI('enabled');
      addSystemMessage('Voice chat enabled. Speak naturally, I\'ll respond!');
      
      // Load KittenTTS in background for better quality
      if (voiceChat && !voiceChat.isModelLoaded && !voiceChat.isModelLoading) {
        voiceChat.loadKittenTTS().then(success => {
          if (success) {
            console.log('KittenTTS loaded - high quality voice enabled');
          }
        });
      }
    }
  }
  
  voiceBtn.addEventListener('click', toggleVoiceChat);

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
    // Render mermaid diagrams after all items are added
    if (window.renderMermaidBlocks) {
      window.renderMermaidBlocks(sharedCanvas);
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

    // Process content for mermaid blocks
    const processedContent = processMermaidContent(item.content);

    div.innerHTML = `
      <div class="canvas-item-header">
        <span class="canvas-item-type">${item.type}</span>
        <span class="canvas-item-user">${item.userName}</span>
      </div>
      <div class="canvas-item-content">${processedContent}</div>
      <div class="canvas-item-time">${time}</div>
    `;

    sharedCanvas.appendChild(div);
    
    // Render mermaid diagrams in this item
    if (window.renderMermaidBlocks) {
      window.renderMermaidBlocks(div);
    }
    
    if (scroll) sharedCanvas.scrollTop = sharedCanvas.scrollHeight;
  }

  // Process content to convert ```mermaid blocks to mermaid divs
  function processMermaidContent(content) {
    if (!content) return '';
    
    // Escape HTML first, then replace mermaid blocks
    let escaped = escapeHtml(content);
    
    // Convert ```mermaid ... ``` blocks to mermaid divs
    escaped = escaped.replace(/```mermaid\n?([\s\S]*?)```/g, function(match, code) {
      return '<div class="mermaid">' + code.trim() + '</div>';
    });
    
    return escaped;
  }

  // Render hierarchical canvas (LangGraph agent's understanding)
  function renderHierarchicalCanvas(canvas) {
    if (!canvas) return;
    
    // Clear canvas
    sharedCanvas.innerHTML = '';
    
    // Add central idea header
    if (canvas.centralIdea) {
      const headerDiv = document.createElement('div');
      headerDiv.className = 'canvas-central-idea';
      headerDiv.innerHTML = `
        <h2>${escapeHtml(canvas.centralIdea)}</h2>
        <span class="canvas-version">v${canvas.version}</span>
      `;
      sharedCanvas.appendChild(headerDiv);
    }
    
    // Store canvas data for path tracking
    currentCanvasData = canvas;
    
    // Render hierarchy
    if (canvas.hierarchy && canvas.hierarchy.length > 0) {
      const hierarchyDiv = document.createElement('div');
      hierarchyDiv.className = 'canvas-hierarchy';
      hierarchyDiv.id = 'hierarchyRoot';
      
      for (let i = 0; i < canvas.hierarchy.length; i++) {
        hierarchyDiv.appendChild(createHierarchyNode(canvas.hierarchy[i], 1, [i]));
      }
      
      sharedCanvas.appendChild(hierarchyDiv);
    } else {
      // Show placeholder if no hierarchy
      sharedCanvas.innerHTML += `
        <div class="canvas-placeholder">
          <p>Agent's Understanding</p>
          <p class="hint">The canvas will update as the agent synthesizes information</p>
        </div>
      `;
    }
    
    sharedCanvas.scrollTop = 0;
  }
  
  // Track current canvas for path tracking
  let currentCanvasData = null;
  
  function createHierarchyNode(node, level, path = []) {
    const div = document.createElement('div');
    div.className = `hierarchy-node level-${level}`;
    div.dataset.path = JSON.stringify(path);
    
    const importance = node.importance || 5;
    const importanceClass = importance >= 8 ? 'high' : importance >= 5 ? 'medium' : 'low';
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = node.expandedContent || hasChildren;
    
    div.innerHTML = `
      <div class="hierarchy-header ${importanceClass} ${isExpanded ? 'expanded' : 'expandable'}" data-expandable="true">
        <span class="hierarchy-toggle">${isExpanded ? '▼' : '▶'}</span>
        <span class="hierarchy-title">${escapeHtml(node.title)}</span>
        <span class="hierarchy-importance" title="Importance: ${importance}/10">${importance}</span>
        <button class="mermaid-btn" title="Generate diagram for this topic">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="9" x2="15" y2="9"></line>
            <line x1="9" y1="15" x2="15" y2="15"></line>
            <line x1="9" y1="9" x2="9" y2="15"></line>
          </svg>
        </button>
      </div>
      ${node.content ? `<div class="hierarchy-content">${processMermaidContent(node.content)}</div>` : ''}
      ${node.expandedContent ? `<div class="hierarchy-expanded-content">${processMermaidContent(node.expandedContent)}</div>` : ''}
      <div class="hierarchy-diagram hidden"></div>
    `;
    
    // Add click handler for expansion
    const header = div.querySelector('.hierarchy-header');
    header.addEventListener('click', (e) => {
      // Don't expand if clicking the mermaid button
      if (e.target.closest('.mermaid-btn')) return;
      
      // If already has expanded content, just toggle visibility
      const expandedContent = div.querySelector('.hierarchy-expanded-content');
      const childrenDiv = div.querySelector('.hierarchy-children');
      
      if (expandedContent || childrenDiv) {
        // Toggle existing content
        if (expandedContent) {
          expandedContent.classList.toggle('hidden');
        }
        if (childrenDiv) {
          childrenDiv.classList.toggle('hidden');
        }
        
        // Update toggle icon
        const toggle = header.querySelector('.hierarchy-toggle');
        toggle.textContent = toggle.textContent === '▼' ? '▶' : '▼';
        header.classList.toggle('expanded');
        header.classList.toggle('collapsed');
      } else {
        // Request expansion from agent
        requestTopicExpansion(node, path, div, header);
      }
    });
    
    // Add click handler for mermaid button
    const mermaidBtn = div.querySelector('.mermaid-btn');
    mermaidBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      requestTopicDiagram(node, path, div, mermaidBtn);
    });
    
    // Add children
    if (hasChildren) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'hierarchy-children';
      
      for (let i = 0; i < node.children.length; i++) {
        const childPath = [...path, i];
        childrenDiv.appendChild(createHierarchyNode(node.children[i], level + 1, childPath));
      }
      
      div.appendChild(childrenDiv);
    }
    
    return div;
  }
  
  function requestTopicExpansion(node, path, nodeDiv, header) {
    if (!socket) return;
    
    // Show loading state
    header.classList.add('loading');
    const toggle = header.querySelector('.hierarchy-toggle');
    toggle.textContent = '◌';
    
    // Add system message about expansion
    addSystemMessage(`Exploring: "${node.title}"...`);
    
    // Emit expansion request
    socket.emit('canvas:expand_topic', {
      topicPath: path,
      topicTitle: node.title,
      topicContent: node.content || ''
    });
  }
  
  function requestTopicDiagram(node, path, nodeDiv, button) {
    if (!socket) return;
    
    // Show loading state
    button.classList.add('loading');
    button.disabled = true;
    
    // Add system message
    addSystemMessage(`Generating diagram for: "${node.title}"...`);
    
    // Emit diagram request
    socket.emit('canvas:generate_diagram', {
      topicPath: path,
      topicTitle: node.title,
      topicContent: node.content || ''
    });
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
  // Cleanup voice chat on page unload
  window.addEventListener('beforeunload', () => {
    if (voiceChat) {
      voiceChat.destroy();
    }
  });
});

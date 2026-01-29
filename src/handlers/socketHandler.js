import { v4 as uuidv4 } from 'uuid';

export class SocketHandler {
  constructor(io, redisClient, agent) {
    this.io = io;
    this.redisClient = redisClient;
    this.agent = agent;
    this.userSessions = new Map(); // Track user sessions
    this.processedMessages = new Set(); // Deduplication set
  }

  setupHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`User connected: ${socket.id}`);

      // Join room
      socket.on('room:join', async (data) => {
        await this.handleRoomJoin(socket, data);
      });

      // Send message (private chat - triggers agent response to this user only)
      socket.on('message:send', async (data) => {
        await this.handleMessage(socket, data);
      });

      // File upload
      socket.on('file:upload', async (data) => {
        await this.handleFileUpload(socket, data);
      });

      // Export request
      socket.on('export:request', async (data) => {
        await this.handleExportRequest(socket, data);
      });

      // Room settings (admin only)
      socket.on('settings:get', async () => {
        await this.handleGetSettings(socket);
      });

      socket.on('settings:set', async (data) => {
        await this.handleSetSettings(socket, data);
      });

      // Heartbeat to keep user alive
      socket.on('heartbeat', async (data) => {
        await this.handleHeartbeat(socket, data);
      });

      // Disconnect
      socket.on('disconnect', async () => {
        await this.handleDisconnect(socket);
      });

      // Error handling
      socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
      });
    });

    // Cleanup old processed messages periodically (every 5 minutes)
    setInterval(() => {
      this.processedMessages.clear();
    }, 5 * 60 * 1000);
  }

  async handleRoomJoin(socket, data) {
    const { roomId, userId, userName, userMetadata = {} } = data;

    if (!roomId || !userId) {
      socket.emit('error', {
        code: 'INVALID_ROOM_DATA',
        message: 'roomId and userId are required'
      });
      return;
    }

    try {
      // Join socket.io room
      socket.join(roomId);

      // Track user session
      this.userSessions.set(socket.id, {
        userId,
        userName: userName || userId,
        roomId,
        joinedAt: Date.now()
      });

      // Register user in Redis
      await this.redisClient.addActiveUser(roomId, userId, {
        socketId: socket.id,
        userName: userName || userId,
        ...userMetadata
      });

      // Register room with agent if first user (they become admin)
      const activeUserCount = await this.redisClient.getActiveUserCount(roomId);
      if (activeUserCount === 1) {
        this.agent.registerRoom(roomId, userId);
      }

      // Get existing active users
      const activeUsers = await this.redisClient.getActiveUsers(roomId);

      // Notify all users in room about the join (public event)
      this.io.to(roomId).emit('room:user_joined', {
        userId,
        userName: userName || userId,
        timestamp: Date.now(),
        activeUsers: activeUsers.length
      });

      // Send active user count
      this.io.to(roomId).emit('room:active_users', {
        count: activeUsers.length
      });

      // Get room state for settings
      const roomState = this.agent.getRoomState(roomId);
      const isAdmin = this.agent.isAdmin(roomId, userId);

      // Send confirmation to joining user
      socket.emit('room:joined', {
        roomId,
        userId,
        userName: userName || userId,
        timestamp: Date.now(),
        activeUserCount: activeUsers.length,
        isAdmin,
        settings: roomState?.settings || { groupChatEnabled: false },
        canvas: roomState?.canvas || [],
        message: `Welcome to Polyphony Space`
      });

      console.log(`User ${userName || userId} joined room ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', {
        code: 'ROOM_JOIN_ERROR',
        message: error.message
      });
    }
  }

  async handleMessage(socket, data) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      socket.emit('error', {
        code: 'NOT_IN_ROOM',
        message: 'Must join a room first'
      });
      return;
    }

    const { roomId, userId, userName } = session;
    const { content, conversationHistory = [], messageId } = data;

    if (!content) {
      socket.emit('error', {
        code: 'EMPTY_MESSAGE',
        message: 'Message content cannot be empty'
      });
      return;
    }

    // Deduplication check
    const dedupKey = `${socket.id}:${messageId || content.slice(0, 50)}:${Date.now() >> 10}`; // ~1 second window
    if (this.processedMessages.has(dedupKey)) {
      console.log('Duplicate message detected, skipping');
      return;
    }
    this.processedMessages.add(dedupKey);

    try {
      // PRIVATE CHAT: Only emit to the sender's socket, not the room
      // First, send acknowledgment that message was received
      socket.emit('message:ack', {
        messageId: messageId || uuidv4(),
        timestamp: Date.now()
      });

      // Trigger agent response (typing indicator only to this user)
      socket.emit('agent:typing');

      const agentResponse = await this.agent.handleMessage(
        roomId,
        userId,
        userName, // Pass userName for canvas attribution
        socket.id, // Pass socket ID for visualization targeting
        content,
        conversationHistory
      );

      socket.emit('agent:done');

      // Send agent response only to this user (PRIVATE)
      socket.emit('agent:response', {
        content: agentResponse.content,
        timestamp: Date.now()
      });

      // If knowledge was updated, broadcast that to ALL users in room (PUBLIC)
      if (agentResponse.knowledgeUpdate) {
        this.io.to(roomId).emit('knowledge:update', agentResponse.knowledgeUpdate);
      }

      console.log(`Message from ${userName} in ${roomId} (private), agent responded`);
    } catch (error) {
      console.error('Error handling message:', error);
      socket.emit('agent:done');
      socket.emit('error', {
        code: 'MESSAGE_ERROR',
        message: error.message
      });
    }
  }

  async handleFileUpload(socket, data) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      socket.emit('error', {
        code: 'NOT_IN_ROOM',
        message: 'Must join a room first'
      });
      return;
    }

    const { roomId, userId, userName } = session;
    const { fileName, fileType, content } = data;

    if (!fileName || !content) {
      socket.emit('error', {
        code: 'INVALID_FILE',
        message: 'File name and content are required'
      });
      return;
    }

    try {
      console.log(`File upload: ${fileName} (${fileType}) from ${userName}`);

      // Notify uploader that processing started
      socket.emit('file:processing', {
        fileName,
        status: 'processing'
      });

      // Process file through agent
      const result = await this.agent.handleFileUpload(
        roomId,
        userId,
        socket.id,
        fileName,
        fileType,
        content
      );

      // Notify ALL users about the new file (PUBLIC)
      this.io.to(roomId).emit('file:processed', {
        fileName,
        fileType,
        userId,
        userName,
        fileId: result.fileInfo.fileId,
        chunkCount: result.fileInfo.chunkCount,
        isLargeFile: result.fileInfo.isLargeFile || false,
        embeddedChunks: result.fileInfo.embeddedChunks,
        lazyChunks: result.fileInfo.lazyChunks,
        timestamp: Date.now()
      });

      // Send agent's analysis summary only to the uploader (PRIVATE)
      if (result.agentSummary) {
        socket.emit('agent:response', {
          content: result.agentSummary,
          timestamp: Date.now()
        });
      }

      // Update knowledge tree for ALL users (PUBLIC)
      if (result.knowledgeUpdate) {
        this.io.to(roomId).emit('knowledge:update', result.knowledgeUpdate);
      }

      console.log(`File processed: ${fileName} (${result.fileInfo.chunkCount} chunks, ${result.fileInfo.totalTokens} tokens)`);
    } catch (error) {
      console.error('Error processing file:', error);
      socket.emit('file:error', {
        fileName,
        error: error.message
      });
    }
  }

  async handleExportRequest(socket, data) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      socket.emit('error', {
        code: 'NOT_IN_ROOM',
        message: 'Must join a room first'
      });
      return;
    }

    const { roomId } = session;

    try {
      console.log(`Export requested for room ${roomId}`);

      const markdown = await this.agent.generateExport(roomId);
      const timestamp = new Date().toISOString().split('T')[0];

      socket.emit('export:ready', {
        markdown,
        fileName: `polyphony-export-${timestamp}.md`
      });

      console.log(`Export generated for room ${roomId}`);
    } catch (error) {
      console.error('Error generating export:', error);
      socket.emit('error', {
        code: 'EXPORT_ERROR',
        message: error.message
      });
    }
  }

  async handleHeartbeat(socket, data) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      return;
    }

    try {
      const { roomId, userId, userName } = session;

      // Refresh user in Redis
      await this.redisClient.addActiveUser(roomId, userId, {
        socketId: socket.id,
        userName,
        lastHeartbeat: Date.now()
      });

      // Send heartbeat confirmation
      socket.emit('heartbeat:ack', {
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error handling heartbeat:', error);
    }
  }

  async handleDisconnect(socket) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      console.log(`User disconnected: ${socket.id} (no session)`);
      return;
    }

    const { roomId, userId, userName } = session;

    try {
      // Remove user from Redis
      await this.redisClient.removeActiveUser(roomId, userId);
      this.userSessions.delete(socket.id);

      // Check if room is now empty
      const activeUserCount = await this.redisClient.getActiveUserCount(roomId);

      if (activeUserCount === 0) {
        // Trigger room cleanup
        this.agent.unregisterRoom(roomId);
        await this.agent.handleRoomCleanup(roomId);
        console.log(`Room ${roomId} is now empty, cleanup initiated`);
      } else {
        // Notify remaining users (PUBLIC)
        this.io.to(roomId).emit('room:user_left', {
          userId,
          userName,
          timestamp: Date.now(),
          activeUsers: activeUserCount
        });

        this.io.to(roomId).emit('room:active_users', {
          count: activeUserCount
        });
      }

      console.log(`User ${userName} disconnected from room ${roomId}`);
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  }

  async handleGetSettings(socket) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      socket.emit('error', { code: 'NOT_IN_ROOM', message: 'Must join a room first' });
      return;
    }

    const { roomId, userId } = session;
    const roomState = this.agent.getRoomState(roomId);
    const isAdmin = this.agent.isAdmin(roomId, userId);

    socket.emit('settings:current', {
      settings: roomState?.settings || { groupChatEnabled: false },
      isAdmin
    });
  }

  async handleSetSettings(socket, data) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      socket.emit('error', { code: 'NOT_IN_ROOM', message: 'Must join a room first' });
      return;
    }

    const { roomId, userId } = session;
    const { groupChatEnabled } = data;

    if (typeof groupChatEnabled !== 'boolean') {
      socket.emit('error', { code: 'INVALID_SETTINGS', message: 'Invalid settings' });
      return;
    }

    const result = this.agent.setGroupChat(roomId, userId, groupChatEnabled);

    if (result.error) {
      socket.emit('error', { code: 'SETTINGS_ERROR', message: result.error });
      return;
    }

    // Broadcast settings change to all users in room
    this.io.to(roomId).emit('settings:updated', {
      settings: { groupChatEnabled },
      changedBy: session.userName
    });

    console.log(`Settings updated in room ${roomId}: groupChatEnabled=${groupChatEnabled}`);
  }
}

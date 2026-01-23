import { v4 as uuidv4 } from 'uuid';

export class SocketHandler {
  constructor(io, redisClient, hiveAgent) {
    this.io = io;
    this.redisClient = redisClient;
    this.hiveAgent = hiveAgent;
    this.userSessions = new Map(); // Track user sessions
  }

  setupHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`✅ User connected: ${socket.id}`);

      // Join room
      socket.on('room:join', async (data) => {
        await this.handleRoomJoin(socket, data);
      });

      // Send thought (text or audio snippet)
      socket.on('thought:stream', async (data) => {
        await this.handleThoughtStream(socket, data);
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
  }

  async handleRoomJoin(socket, data) {
    const { roomId, userId, userMetadata = {} } = data;

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
        roomId,
        joinedAt: Date.now()
      });

      // Register user in Redis
      await this.redisClient.addActiveUser(roomId, userId, {
        socketId: socket.id,
        ...userMetadata
      });

      // Register room if first user
      const activeUserCount = await this.redisClient.getActiveUserCount(roomId);
      if (activeUserCount === 1) {
        this.hiveAgent.registerRoom(roomId);
      }

      // Get existing active users
      const activeUsers = await this.redisClient.getActiveUsers(roomId);

      // Notify all users in room
      this.io.to(roomId).emit('room:user_joined', {
        userId,
        timestamp: Date.now(),
        activeUsers,
        activeUserCount
      });

      // Send confirmation to joining user
      socket.emit('room:joined', {
        roomId,
        userId,
        timestamp: Date.now(),
        activeUserCount,
        message: `Welcome to Polyphony Room ${roomId}`
      });

      console.log(`👤 User ${userId} joined room ${roomId}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', {
        code: 'ROOM_JOIN_ERROR',
        message: error.message
      });
    }
  }

  async handleThoughtStream(socket, data) {
    const session = this.userSessions.get(socket.id);
    if (!session) {
      socket.emit('error', {
        code: 'NOT_IN_ROOM',
        message: 'Must join a room first'
      });
      return;
    }

    const { roomId, userId } = session;
    const { content, type = 'text', metadata = {} } = data;

    if (!content) {
      socket.emit('error', {
        code: 'EMPTY_THOUGHT',
        message: 'Thought content cannot be empty'
      });
      return;
    }

    try {
      // Store thought in Redis
      const thoughtId = await this.redisClient.storeThought(
        roomId,
        userId,
        content,
        null, // embedding placeholder
        3600 // 1 hour TTL
      );

      // Broadcast thought to all users in room
      this.io.to(roomId).emit('thought:received', {
        thoughtId,
        userId,
        content,
        type,
        timestamp: Date.now(),
        metadata
      });

      console.log(`💭 Thought stored: ${thoughtId} from ${userId}`);
    } catch (error) {
      console.error('Error storing thought:', error);
      socket.emit('error', {
        code: 'THOUGHT_STORAGE_ERROR',
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
      const { roomId, userId } = session;
      
      // Refresh user in Redis
      await this.redisClient.addActiveUser(roomId, userId, {
        socketId: socket.id,
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
      console.log(`❌ User disconnected: ${socket.id} (no session)`);
      return;
    }

    const { roomId, userId } = session;

    try {
      // Remove user from Redis
      await this.redisClient.removeActiveUser(roomId, userId);
      this.userSessions.delete(socket.id);

      // Check if room is now empty
      const activeUserCount = await this.redisClient.getActiveUserCount(roomId);

      if (activeUserCount === 0) {
        // Trigger room cleanup
        this.hiveAgent.unregisterRoom(roomId);
        await this.hiveAgent.handleRoomCleanup(roomId);
        console.log(`🏚️ Room ${roomId} is now empty, cleanup initiated`);
      } else {
        // Notify remaining users
        const activeUsers = await this.redisClient.getActiveUsers(roomId);
        this.io.to(roomId).emit('room:user_left', {
          userId,
          timestamp: Date.now(),
          activeUsers,
          activeUserCount
        });
      }

      console.log(`👋 User ${userId} disconnected from room ${roomId}`);
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  }
}

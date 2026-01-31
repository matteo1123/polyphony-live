import { createClient } from 'redis';

export class RedisClient {
  constructor(host = 'localhost', port = 6379) {
    this.host = host;
    this.port = port;
    this.client = null;
  }

  async connect() {
    this.client = createClient({
      host: this.host,
      port: this.port,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500)
      }
    });

    this.client.on('error', (err) => {
      console.error('Redis client error:', err);
    });

    this.client.on('connect', () => {
      console.log('✅ Redis client connected');
    });

    this.client.on('reconnecting', () => {
      console.log('🔄 Redis client reconnecting...');
    });

    await this.client.connect();
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      console.log('Redis client disconnected');
    }
  }

  // Store thought/content snippet
  // TTL: null = no expiration (lives until room cleanup), number = seconds until expiration
  async storeThought(roomId, userId, content, embedding = null, ttl = null) {
    const thoughtId = `${roomId}:thought:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    const thoughtData = {
      id: thoughtId,
      roomId,
      userId,
      content,
      timestamp: Date.now().toString()
    };

    // Only add embedding if provided
    if (embedding) {
      thoughtData.embedding = JSON.stringify(embedding);
    }

    // Store in hash
    await this.client.hSet(thoughtId, thoughtData);

    // Add to sorted set for quick retrieval by room and time
    await this.client.zAdd(`${roomId}:thoughts`, {
      score: Date.now(),
      value: thoughtId
    });

    // Only set TTL if specified (null = no expiration, ephemeral until room closes)
    if (ttl !== null && ttl > 0) {
      await this.client.expire(thoughtId, ttl);
    }

    return thoughtId;
  }

  // Get all thoughts in a room
  async getThoughtsByRoom(roomId, limit = 100) {
    const thoughtIds = await this.client.zRange(`${roomId}:thoughts`, -limit, -1);
    const thoughts = [];

    for (const thoughtId of thoughtIds) {
      const thought = await this.client.hGetAll(thoughtId);
      if (Object.keys(thought).length > 0) {
        thoughts.push(thought);
      }
    }

    return thoughts;
  }

  // Track active users in a room
  async addActiveUser(roomId, userId, metadata = {}) {
    const userKey = `${roomId}:user:${userId}`;
    await this.client.hSet(userKey, {
      userId,
      joinedAt: Date.now(),
      ...metadata
    });
    await this.client.zAdd(`${roomId}:active_users`, {
      score: Date.now(),
      value: userId
    });
    await this.client.expire(userKey, 300); // 5 min heartbeat TTL
  }

  async removeActiveUser(roomId, userId) {
    const userKey = `${roomId}:user:${userId}`;
    await this.client.zRem(`${roomId}:active_users`, userId);
    await this.client.del(userKey);
  }

  async getActiveUsers(roomId) {
    const userIds = await this.client.zRange(`${roomId}:active_users`, 0, -1);
    return userIds;
  }

  async getActiveUserCount(roomId) {
    return await this.client.zCard(`${roomId}:active_users`);
  }

  // Cleanup room when last user leaves
  async cleanupRoom(roomId) {
    const pattern = `${roomId}:*`;
    const keys = await this.client.keys(pattern);
    
    if (keys.length > 0) {
      await this.client.del(keys);
      console.log(`🧹 Cleaned up ${keys.length} keys for room ${roomId}`);
    }
    
    // Remove from active rooms set
    await this.client.sRem('active_rooms', roomId);
  }

  // Mark room as active (has vectors loaded)
  async markRoomActive(roomId) {
    await this.client.sAdd('active_rooms', roomId);
    await this.client.hSet(`room:${roomId}:meta`, {
      roomId,
      activatedAt: Date.now(),
      lastActivity: Date.now()
    });
  }

  // Mark room as inactive (vectors cleared)
  async markRoomInactive(roomId) {
    await this.client.sRem('active_rooms', roomId);
    await this.client.del(`room:${roomId}:meta`);
  }

  // Check if room is active
  async isRoomActive(roomId) {
    return await this.client.sIsMember('active_rooms', roomId);
  }

  // Get count of active rooms
  async getActiveRoomCount() {
    return await this.client.sCard('active_rooms');
  }

  // Get all active rooms with metadata
  async getAllActiveRooms() {
    const roomIds = await this.client.sMembers('active_rooms');
    const rooms = [];
    
    for (const roomId of roomIds) {
      const meta = await this.client.hGetAll(`room:${roomId}:meta`);
      if (meta && meta.roomId) {
        rooms.push(meta);
      }
    }
    
    return rooms;
  }

  // Update room activity timestamp
  async updateRoomActivity(roomId) {
    await this.client.hSet(`room:${roomId}:meta`, 'lastActivity', Date.now());
  }

  // Get client for direct redis operations
  getClient() {
    return this.client;
  }
}

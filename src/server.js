import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { RedisClient } from './services/redisClient.js';
import { HiveAgent } from './services/hiveAgent.js';
import { SocketHandler } from './handlers/socketHandler.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || ['http://localhost:3001', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Initialize Redis client
const redisClient = new RedisClient(
  process.env.REDIS_HOST || 'localhost',
  parseInt(process.env.REDIS_PORT || '6379')
);

// Initialize Hive Agent
const hiveAgent = new HiveAgent(redisClient, io);

// Setup Socket.io handlers
const socketHandler = new SocketHandler(io, redisClient, hiveAgent);
socketHandler.setupHandlers();

// Start Hive Agent synthesis loop
hiveAgent.startSynthesisLoop();

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  try {
    await redisClient.connect();
    console.log(`🚀 Polyphony.live server running on port ${PORT}`);
    console.log(`📡 Redis connected to ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
    console.log(`🧠 Hive Agent synthesis loop started`);
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  hiveAgent.stopSynthesisLoop();
  await redisClient.disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

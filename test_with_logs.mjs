import io from 'socket.io-client';

const API_URL = 'http://localhost:3000';

console.log('Testing with detailed logging...\n');

const socket = io(API_URL, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  console.log('✅ Connected to server');
  socket.emit('room:join', {
    roomId: 'debug-test-' + Date.now(),
    userId: 'debug-user',
    userName: 'Debugger'
  });
});

socket.on('room:joined', (data) => {
  console.log('✅ Joined room:', data.roomId);
  
  setTimeout(() => {
    console.log('\n📤 Sending: "Tell me about the Eiffel Tower"');
    socket.emit('message:send', {
      content: 'Tell me about the Eiffel Tower',
      messageId: 'test-1',
      conversationHistory: []
    });
  }, 500);
});

socket.on('agent:typing', () => console.log('⏳ Agent is typing...'));
socket.on('agent:done', () => console.log('✓ Agent done'));

socket.on('agent:response', (data) => {
  console.log('\n📨 Agent response:', data.content.substring(0, 200));
  socket.disconnect();
  process.exit(0);
});

socket.on('knowledge:update', (data) => {
  console.log('📚 Knowledge update:', data.topics?.length, 'topics');
});

socket.on('canvas:update', (data) => {
  console.log('🎨 Canvas update:', data.contribution?.type);
});

socket.on('error', (data) => {
  console.log('❌ Socket error:', data);
});

setTimeout(() => {
  console.log('\n⏱️ Timeout - no response received');
  process.exit(1);
}, 15000);

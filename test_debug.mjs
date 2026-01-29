import io from 'socket.io-client';

const API_URL = 'http://localhost:3000';

console.log('Testing agent with debug...\n');

const socket = io(API_URL, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  console.log('Connected');
  socket.emit('room:join', {
    roomId: 'debug-test-' + Date.now(),
    userId: 'debug-user',
    userName: 'Debugger'
  });
});

socket.on('room:joined', (data) => {
  console.log('Joined:', data);
  console.log('\nSending test message...');
  socket.emit('message:send', {
    content: 'What is the capital of France?',
    messageId: 'test-1',
    conversationHistory: []
  });
});

socket.on('agent:response', (data) => {
  console.log('\n📨 Agent response:', data.content);
  socket.disconnect();
  process.exit(0);
});

socket.on('error', (data) => {
  console.log('❌ Error:', data);
});

setTimeout(() => {
  console.log('\n⏱️ Timeout');
  process.exit(1);
}, 10000);

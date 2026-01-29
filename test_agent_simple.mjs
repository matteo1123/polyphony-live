import io from 'socket.io-client';

const API_URL = 'http://localhost:3000';
const socket = io(API_URL, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  console.log('Connected');
  socket.emit('room:join', {
    roomId: 'simple-test-' + Date.now(),
    userId: 'test-user',
    userName: 'Tester'
  });
});

socket.on('room:joined', () => {
  console.log('Joined, sending message...');
  socket.emit('message:send', {
    content: 'What is 2+2?',
    messageId: 'test-1',
    conversationHistory: []
  });
});

socket.on('agent:response', (data) => {
  console.log('Response:', data.content || '(empty)');
  socket.disconnect();
  process.exit(0);
});

socket.on('error', (data) => {
  console.log('Error:', data);
});

setTimeout(() => {
  console.log('Timeout');
  process.exit(1);
}, 10000);

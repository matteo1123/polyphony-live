import io from 'socket.io-client';

const API_URL = 'http://localhost:3000';

console.log('Testing file upload with intelligent chunking...\n');

const socket = io(API_URL, { transports: ['websocket', 'polling'] });

// Create a sample text that will demonstrate chunking
const sampleDoc = `
Introduction to Artificial Intelligence

Artificial Intelligence (AI) is a branch of computer science that aims to create machines capable of intelligent behavior. This field has grown tremendously over the past few decades, transforming from theoretical research into practical applications that affect our daily lives.

The concept of AI dates back to ancient history, with myths and stories about artificial beings. However, the formal foundation was laid in 1956 at the Dartmouth Conference, where the term "Artificial Intelligence" was coined.

Machine Learning Fundamentals

Machine Learning is a subset of AI that enables computers to learn from data without being explicitly programmed. There are three main types of machine learning:

Supervised learning uses labeled training data to learn a mapping from inputs to outputs. The algorithm is trained on a dataset that includes both the input features and the correct output labels. Common applications include spam detection, image classification, and sentiment analysis.

Unsupervised learning works with unlabeled data to find hidden patterns or intrinsic structures. Clustering and dimensionality reduction are common unsupervised learning tasks. Applications include customer segmentation, anomaly detection, and recommendation systems.

Reinforcement learning involves an agent learning to make decisions by performing actions in an environment to maximize cumulative reward. This approach has been successful in game playing, robotics, and autonomous systems.

Deep Learning and Neural Networks

Deep Learning is a subset of machine learning based on artificial neural networks with multiple layers. These deep neural networks can learn hierarchical representations of data, automatically discovering intricate structures in high-dimensional data.

Convolutional Neural Networks (CNNs) are particularly effective for image processing tasks. They use convolutional layers to detect local features and pooling layers to reduce spatial dimensions. CNNs power many computer vision applications including facial recognition, medical image analysis, and self-driving cars.

Recurrent Neural Networks (RNNs) are designed for sequential data processing. They maintain internal state that can capture information about previous inputs, making them suitable for time series analysis, natural language processing, and speech recognition. Long Short-Term Memory (LSTM) networks address the vanishing gradient problem in traditional RNNs.

Transformer architectures have revolutionized natural language processing. The attention mechanism allows models to weigh the importance of different input tokens when producing each output token. Models like BERT, GPT, and T5 have achieved state-of-the-art results on various NLP benchmarks.

Ethical Considerations in AI

As AI systems become more powerful and widespread, ethical considerations become increasingly important. Bias in training data can lead to unfair outcomes, affecting hiring decisions, loan approvals, and criminal justice.

Privacy concerns arise from the data-intensive nature of modern AI. Training large models requires massive datasets, often containing personal information. Techniques like federated learning and differential privacy aim to address these concerns.

Transparency and explainability are crucial for building trust in AI systems. Users and stakeholders need to understand how decisions are made, especially in high-stakes applications like healthcare and finance.

The Future of AI

The field continues to evolve rapidly. Research directions include artificial general intelligence (AGI), quantum machine learning, and neuromorphic computing. As these technologies mature, they promise to reshape industries and society in profound ways.
`;

socket.on('connect', () => {
  console.log('✅ Connected');
  socket.emit('room:join', {
    roomId: 'file-test-' + Date.now(),
    userId: 'test-user',
    userName: 'Test User'
  });
});

socket.on('room:joined', (data) => {
  console.log('✅ Joined room:', data.roomId);
  
  setTimeout(() => {
    console.log('\n📤 Uploading document (3,500+ chars)...');
    socket.emit('file:upload', {
      fileName: 'AI_Introduction.txt',
      fileType: '.txt',
      content: sampleDoc
    });
  }, 500);
});

socket.on('file:processing', (data) => {
  console.log('⏳ Processing:', data.fileName);
});

socket.on('file:processed', (data) => {
  console.log('✅ File processed:', data.fileName);
  console.log('   Chunks:', data.pageCount); // This now shows chunk count
});

socket.on('agent:response', (data) => {
  console.log('\n📨 Agent analysis:', data.content.slice(0, 300) + '...');
});

socket.on('knowledge:update', (data) => {
  console.log('📚 Knowledge entries:', data.topics?.length || 0, 'topics');
  if (data.topics?.length > 0) {
    data.topics.forEach(t => {
      console.log('   -', t.title, `(${t.badge} entries)`);
    });
    socket.disconnect();
    process.exit(0);
  }
});

socket.on('error', (data) => {
  console.log('❌ Error:', data);
});

setTimeout(() => {
  console.log('\n⏱️ Timeout');
  socket.disconnect();
  process.exit(1);
}, 30000);

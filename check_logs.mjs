import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

console.log('Environment check:');
console.log('GOOGLE_AI_API_KEY exists:', !!process.env.GOOGLE_AI_API_KEY);
console.log('Key length:', process.env.GOOGLE_AI_API_KEY?.length);
console.log('Key starts with:', process.env.GOOGLE_AI_API_KEY?.slice(0, 10) + '...');

// Test the API
const apiKey = process.env.GOOGLE_AI_API_KEY;
if (apiKey) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    console.log('\nTesting Gemini API...');
    const result = await model.generateContent('Say "Polyphony test successful"');
    console.log('✅ API Test result:', result.response.text());
  } catch (e) {
    console.log('❌ API Error:', e.message);
  }
}

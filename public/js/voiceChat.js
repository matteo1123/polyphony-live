/**
 * VoiceChat - Browser-based voice interaction for Polyphony
 * 
 * Features:
 * - Speech-to-Text: Web Speech API (fast, built-in)
 * - Text-to-Speech: Web Speech API with optional KittenTTS enhancement
 * 
 * TTS Options:
 * 1. Web Speech API (default): Fast, works offline, quality varies by browser/OS
 * 2. KittenTTS (optional): Higher quality neural voice, ~25MB download, runs locally
 */

export class VoiceChat {
  constructor(options = {}) {
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterimTranscript = options.onInterimTranscript || (() => {});
    this.onStart = options.onStart || (() => {});
    this.onEnd = options.onEnd || (() => {});
    this.onError = options.onError || (() => {});
    this.onTTSStart = options.onTTSStart || (() => {});
    this.onTTSEnd = options.onTTSEnd || (() => {});
    this.onModelLoad = options.onModelLoad || (() => {});
    
    // State
    this.isListening = false;
    this.isSpeaking = false;
    this.isModelLoading = false;
    this.isModelLoaded = false;
    this.recognition = null;
    this.synthesis = window.speechSynthesis || null;
    
    // TTS Provider: 'webspeech' | 'kittentts' | 'auto'
    this.ttsProvider = options.ttsProvider || 'auto';
    
    // KittenTTS
    this.kittenTTS = null;
    this.kittenTTSUrl = options.kittenTTSUrl || 'https://cdn.jsdelivr.net/npm/kitten-tts-web@latest/dist';
    this.preferredVoice = null;
    
    // Audio context for better audio handling
    this.audioContext = null;
    
    // Transcript buffer
    this.transcriptBuffer = '';
    this.silenceTimer = null;
    this.silenceTimeout = options.silenceTimeout || 1500; // Send after 1.5s of silence
    
    this.init();
  }

  /**
   * Initialize voice chat - check capabilities
   */
  init() {
    // Check for Web Speech API support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      console.warn('VoiceChat: Web Speech API not supported in this browser');
      this.onError({ type: 'STT_UNSUPPORTED', message: 'Speech recognition not supported' });
      return;
    }

    // Initialize recognition
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    
    // Setup recognition handlers
    this.recognition.onstart = () => {
      this.isListening = true;
      this.onStart();
    };
    
    this.recognition.onend = () => {
      this.isListening = false;
      this.onEnd();
      
      // Auto-restart if we should still be listening (unless stopped manually)
      if (this.shouldBeListening && !this.isSpeaking) {
        setTimeout(() => this.startListening(), 100);
      }
    };
    
    this.recognition.onresult = (event) => {
      this.handleRecognitionResult(event);
    };
    
    this.recognition.onerror = (event) => {
      console.error('VoiceChat: Recognition error', event.error);
      
      // Don't treat 'no-speech' as an error
      if (event.error === 'no-speech') {
        return;
      }
      
      this.onError({ type: 'STT_ERROR', error: event.error });
      
      // Auto-restart on certain errors
      if (event.error === 'network' || event.error === 'service-not-allowed') {
        setTimeout(() => {
          if (this.shouldBeListening) {
            this.startListening();
          }
        }, 1000);
      }
    };

    // Initialize audio context
    this.initAudioContext();
    
    console.log('VoiceChat: Initialized successfully');
  }

  /**
   * Initialize audio context for better audio handling
   */
  initAudioContext() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('VoiceChat: AudioContext not supported');
    }
  }

  /**
   * Handle recognition results
   */
  handleRecognitionResult(event) {
    let interimTranscript = '';
    let finalTranscript = '';
    
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    
    // Send interim transcript for UI feedback
    if (interimTranscript) {
      this.onInterimTranscript(interimTranscript);
    }
    
    // Handle final transcript
    if (finalTranscript) {
      this.transcriptBuffer += finalTranscript;
      
      // Clear any existing silence timer
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
      }
      
      // Set a new silence timer to send the transcript after pause
      this.silenceTimer = setTimeout(() => {
        if (this.transcriptBuffer.trim()) {
          this.onTranscript(this.transcriptBuffer.trim());
          this.transcriptBuffer = '';
        }
      }, this.silenceTimeout);
    }
  }

  /**
   * Check if voice chat is supported
   */
  isSupported() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    return !!SpeechRecognition;
  }

  /**
   * Start listening for speech
   */
  startListening() {
    if (!this.recognition) {
      this.onError({ type: 'NOT_INITIALIZED', message: 'Voice chat not initialized' });
      return false;
    }
    
    if (this.isListening) {
      return true;
    }
    
    this.shouldBeListening = true;
    
    try {
      // Resume audio context if suspended (browser policy)
      if (this.audioContext && this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }
      
      this.recognition.start();
      return true;
    } catch (error) {
      console.error('VoiceChat: Failed to start listening', error);
      this.onError({ type: 'START_ERROR', message: error.message });
      return false;
    }
  }

  /**
   * Stop listening for speech
   */
  stopListening() {
    this.shouldBeListening = false;
    
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    
    // Send any remaining buffered transcript
    if (this.transcriptBuffer.trim()) {
      this.onTranscript(this.transcriptBuffer.trim());
      this.transcriptBuffer = '';
    }
    
    if (this.recognition && this.isListening) {
      try {
        this.recognition.stop();
      } catch (error) {
        console.warn('VoiceChat: Error stopping recognition', error);
      }
    }
  }

  /**
   * Load KittenTTS model on demand
   * Falls back to Web Speech API if KittenTTS is not available
   */
  async loadKittenTTS() {
    if (this.isModelLoaded) {
      return true;
    }
    
    if (this.isModelLoading) {
      // Wait for existing load to complete
      while (this.isModelLoading) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.isModelLoaded;
    }
    
    this.isModelLoading = true;
    this.onModelLoad({ status: 'loading', progress: 0 });
    
    try {
      // Try to dynamically import KittenTTS
      // Note: KittenTTS needs to be installed as a dependency or available via CDN
      let module;
      try {
        module = await import(this.kittenTTSUrl + '/kitten-tts.esm.js');
      } catch (cdnError) {
        // Try alternative CDN
        module = await import('https://unpkg.com/kitten-tts-web@latest/dist/kitten-tts.esm.js');
      }
      
      const { KittenTTS } = module;
      
      this.kittenTTS = new KittenTTS({
        modelUrl: this.kittenTTSUrl + '/models/nano',
        onProgress: (progress) => {
          console.log(`VoiceChat: KittenTTS loading ${Math.round(progress * 100)}%`);
          this.onModelLoad({ status: 'loading', progress });
        }
      });
      
      await this.kittenTTS.load();
      
      this.isModelLoaded = true;
      this.ttsProvider = 'kittentts';
      this.onModelLoad({ status: 'loaded', progress: 1 });
      console.log('VoiceChat: KittenTTS loaded successfully');
      return true;
    } catch (error) {
      console.warn('VoiceChat: KittenTTS not available, using Web Speech API', error);
      this.isModelLoaded = false;
      this.ttsProvider = 'webspeech';
      this.onModelLoad({ status: 'fallback', progress: 1 });
      return false;
    } finally {
      this.isModelLoading = false;
    }
  }
  
  /**
   * Get current TTS provider name
   */
  getTTSProvider() {
    if (this.ttsProvider === 'auto') {
      return this.isModelLoaded ? 'kittentts' : 'webspeech';
    }
    return this.ttsProvider;
  }

  /**
   * Speak text using TTS (KittenTTS if available, fallback to Web Speech API)
   */
  async speak(text, options = {}) {
    if (!text) return;
    
    // Stop any ongoing speech
    this.stopSpeaking();
    
    this.isSpeaking = true;
    this.onTTSStart();
    
    // Pause listening while speaking to avoid feedback loop
    const wasListening = this.isListening;
    if (wasListening) {
      this.stopListening();
    }
    
    try {
      // Try KittenTTS if loaded
      if (this.isModelLoaded && this.kittenTTS && !options.useFallback) {
        await this.speakWithKittenTTS(text, options);
      } else {
        // Fallback to Web Speech API
        await this.speakWithWebSpeech(text, options);
      }
    } catch (error) {
      console.error('VoiceChat: TTS error', error);
      // Try fallback
      if (!options.useFallback) {
        await this.speakWithWebSpeech(text, { ...options, useFallback: true });
      }
    } finally {
      this.isSpeaking = false;
      this.onTTSEnd();
      
      // Resume listening if it was active
      if (wasListening && this.shouldBeListening) {
        setTimeout(() => this.startListening(), 200);
      }
    }
  }

  /**
   * Speak using KittenTTS
   */
  async speakWithKittenTTS(text, options = {}) {
    const audioBuffer = await this.kittenTTS.synthesize(text, {
      speed: options.speed || 1.0,
      pitch: options.pitch || 1.0
    });
    
    await this.playAudioBuffer(audioBuffer);
  }

  /**
   * Speak using Web Speech API
   */
  speakWithWebSpeech(text, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.synthesis) {
        reject(new Error('Speech synthesis not supported'));
        return;
      }
      
      // Cancel any ongoing speech
      this.synthesis.cancel();
      
      const utterance = new SpeechSynthesisUtterance(text);
      
      // Try to find a good voice
      const voices = this.synthesis.getVoices();
      
      // Prefer these voices (in order of quality)
      const preferredVoices = [
        'Google US English',
        'Microsoft David',
        'Microsoft Zira',
        'Samantha',
        'Alex',
        'Google UK English Female',
        'Google UK English Male'
      ];
      
      if (!this.preferredVoice) {
        for (const name of preferredVoices) {
          const voice = voices.find(v => v.name.includes(name));
          if (voice) {
            this.preferredVoice = voice;
            break;
          }
        }
        
        // Fallback to any English voice
        if (!this.preferredVoice) {
          this.preferredVoice = voices.find(v => v.lang.startsWith('en'));
        }
      }
      
      if (this.preferredVoice) {
        utterance.voice = this.preferredVoice;
      }
      
      utterance.rate = options.speed || 1.0;
      utterance.pitch = options.pitch || 1.0;
      utterance.volume = options.volume || 1.0;
      
      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        if (event.error !== 'canceled') {
          reject(new Error(`Speech synthesis error: ${event.error}`));
        } else {
          resolve();
        }
      };
      
      this.synthesis.speak(utterance);
    });
  }

  /**
   * Play audio buffer through AudioContext
   */
  async playAudioBuffer(audioBuffer) {
    if (!this.audioContext) {
      this.initAudioContext();
    }
    
    return new Promise((resolve, reject) => {
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);
      
      source.onended = () => resolve();
      source.start();
    });
  }

  /**
   * Stop speaking
   */
  stopSpeaking() {
    if (this.synthesis) {
      this.synthesis.cancel();
    }
    
    if (this.audioContext) {
      // Stop all playing sources
      this.audioContext.suspend();
      this.audioContext.resume();
    }
    
    this.isSpeaking = false;
  }

  /**
   * Toggle listening state
   */
  toggleListening() {
    if (this.isListening) {
      this.stopListening();
      return false;
    } else {
      return this.startListening();
    }
  }

  /**
   * Enable voice mode - downloads TTS model if needed
   */
  async enableVoiceMode() {
    // Start listening immediately with Web Speech STT
    this.startListening();
    
    // Load KittenTTS in background for better TTS quality
    if (!this.isModelLoaded && !this.isModelLoading) {
      this.loadKittenTTS().then(success => {
        if (success) {
          console.log('VoiceChat: Voice mode fully enabled with KittenTTS');
        } else {
          console.log('VoiceChat: Voice mode enabled with Web Speech fallback');
        }
      });
    }
    
    return true;
  }

  /**
   * Disable voice mode
   */
  disableVoiceMode() {
    this.stopListening();
    this.stopSpeaking();
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isListening: this.isListening,
      isSpeaking: this.isSpeaking,
      isModelLoaded: this.isModelLoaded,
      isModelLoading: this.isModelLoading,
      hasSTTSupport: !!this.recognition,
      hasTTSSupport: !!(this.kittenTTS || this.synthesis)
    };
  }

  /**
   * Destroy the voice chat instance
   */
  destroy() {
    this.disableVoiceMode();
    
    if (this.recognition) {
      this.recognition.onstart = null;
      this.recognition.onend = null;
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition = null;
    }
    
    if (this.kittenTTS) {
      this.kittenTTS.dispose?.();
      this.kittenTTS = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

/**
 * Simple VoiceButton component for easy integration
 */
export class VoiceButton {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' 
      ? document.querySelector(container) 
      : container;
    
    if (!this.container) {
      throw new Error('VoiceButton: Container not found');
    }
    
    this.voiceChat = new VoiceChat(options);
    this.isEnabled = false;
    
    this.render();
    this.attachEvents();
  }

  render() {
    this.container.innerHTML = `
      <button class="voice-btn" id="voiceToggleBtn" title="Enable voice chat">
        <svg class="voice-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
          <line x1="12" y1="19" x2="12" y2="23"></line>
          <line x1="8" y1="23" x2="16" y2="23"></line>
        </svg>
        <span class="voice-status">Voice</span>
        <div class="voice-indicator hidden"></div>
        <div class="voice-loading hidden">
          <div class="voice-spinner"></div>
        </div>
      </button>
    `;
    
    this.button = this.container.querySelector('#voiceToggleBtn');
    this.indicator = this.container.querySelector('.voice-indicator');
    this.loading = this.container.querySelector('.voice-loading');
    this.status = this.container.querySelector('.voice-status');
  }

  attachEvents() {
    this.button.addEventListener('click', () => this.toggle());
    
    // Listen to voice chat events
    const originalOnStart = this.voiceChat.onStart;
    const originalOnEnd = this.voiceChat.onEnd;
    const originalOnTTSStart = this.voiceChat.onTTSStart;
    const originalOnTTSEnd = this.voiceChat.onTTSEnd;
    
    this.voiceChat.onStart = () => {
      this.updateUI('listening');
      originalOnStart();
    };
    
    this.voiceChat.onEnd = () => {
      if (this.isEnabled) {
        this.updateUI('enabled');
      } else {
        this.updateUI('disabled');
      }
      originalOnEnd();
    };
    
    this.voiceChat.onTTSStart = () => {
      this.updateUI('speaking');
      originalOnTTSStart();
    };
    
    this.voiceChat.onTTSEnd = () => {
      this.updateUI(this.isEnabled ? 'enabled' : 'disabled');
      originalOnTTSEnd();
    };
  }

  async toggle() {
    if (!this.voiceChat.isSupported()) {
      alert('Voice chat is not supported in your browser. Please use Chrome, Edge, or Safari.');
      return;
    }
    
    if (this.isEnabled) {
      // Disable voice mode
      this.voiceChat.disableVoiceMode();
      this.isEnabled = false;
      this.updateUI('disabled');
    } else {
      // Enable voice mode
      this.updateUI('loading');
      await this.voiceChat.enableVoiceMode();
      this.isEnabled = true;
      this.updateUI('enabled');
    }
  }

  updateUI(state) {
    this.button.classList.remove('listening', 'speaking', 'loading', 'enabled');
    this.indicator.classList.add('hidden');
    this.loading.classList.add('hidden');
    
    switch (state) {
      case 'listening':
        this.button.classList.add('listening');
        this.indicator.classList.remove('hidden');
        this.status.textContent = 'Listening...';
        break;
      case 'speaking':
        this.button.classList.add('speaking');
        this.status.textContent = 'Speaking...';
        break;
      case 'loading':
        this.button.classList.add('loading');
        this.loading.classList.remove('hidden');
        this.status.textContent = 'Loading...';
        break;
      case 'enabled':
        this.button.classList.add('enabled');
        this.indicator.classList.remove('hidden');
        this.status.textContent = 'Voice On';
        break;
      default:
        this.status.textContent = 'Voice';
    }
  }

  speak(text, options) {
    return this.voiceChat.speak(text, options);
  }

  destroy() {
    this.voiceChat.destroy();
    this.container.innerHTML = '';
  }
}

export default VoiceChat;

import { useEffect, useRef } from 'react';
import { RealtimeSTTClient } from './logic/stt_client';

function App() {
  const sttRef = useRef(null);

  useEffect(() => {
    sttRef.current = new RealtimeSTTClient({
      wsUrl: 'ws://YOUR_SERVER_IP:31376/ws',
      threshold: 0.02,
      onStatus: (msg) => console.log('[Status]', msg),
      onTranscript: (text) => console.log('[STT]', text),
    });
    sttRef.current.init();
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold mb-4">🎤 Whisper STT Test</h1>
      <div className="space-x-4">
        <button
          className="px-4 py-2 bg-green-500 text-white rounded"
          onClick={() => sttRef.current?.start()}
        >
          ▶ Start
        </button>
        <button
          className="px-4 py-2 bg-red-500 text-white rounded"
          onClick={() => sttRef.current?.stop()}
        >
          ⏹ Stop
        </button>
      </div>
    </div>
  );
}

export default App;

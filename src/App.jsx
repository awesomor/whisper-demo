import { useRef } from 'react';
import { useWhisperSTT } from './hooks/useWhisperSTT';

export default function App() {
  const audioRef = useRef(null);
  const {
    status,
    transcript,
    startMicSTT,
    startAudioSTT,
    stopSTT,
    clearTranscript,
  } = useWhisperSTT(); // 기본 WS는 env 또는 ws://114.110.135.253:5001

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-bold">🎤 Whisper STT (마이크 + 오디오 재생)</h1>

      {/* 기존 파형/플레이어에 붙여 쓰면 됨 */}
      <audio ref={audioRef} src="/demo.wav" controls className="w-full" />

      <div className="flex gap-2 flex-wrap">
        <button
          className="px-3 py-2 rounded bg-green-600 text-white"
          onClick={() => startMicSTT()}
        >
          🎙 마이크 STT 시작
        </button>

        <button
          className="px-3 py-2 rounded bg-blue-600 text-white"
          onClick={() => {
            const el = audioRef.current;
            if (!el) return;
            el.play();
            startAudioSTT(el);
          }}
        >
          🎵 오디오 재생 STT 시작
        </button>

        <button
          className="px-3 py-2 rounded bg-gray-700 text-white"
          onClick={stopSTT}
        >
          ⛔ Stop
        </button>

        <button
          className="px-3 py-2 rounded bg-orange-600 text-white"
          onClick={clearTranscript}
        >
          🧹 로그 비우기
        </button>
      </div>

      <div className="text-sm text-gray-400">Status: {status}</div>

      <pre className="p-3 bg-black/80 text-green-200 rounded h-64 overflow-auto whitespace-pre-wrap">
{transcript || '여기에 Whisper 텍스트 로그가 누적됩니다…'}
      </pre>
    </div>
  );
}

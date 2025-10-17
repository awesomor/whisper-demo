// React Hook: 마이크/오디오 재생 둘 다 지원 + 텍스트 로그 누적
import { useCallback, useEffect, useRef, useState } from 'react';
import { RealtimeSTTClient } from '../logic/stt_client';

// 기본 WS URL: .env에 VITE_WHISPER_WS_URL 있으면 그걸 우선 사용
const DEFAULT_WS_URL =
  (import.meta?.env && import.meta.env.VITE_WHISPER_WS_URL) ||
  'ws://114.110.135.253:5001';

export function useWhisperSTT({ wsUrl = DEFAULT_WS_URL, threshold = 0.02 } = {}) {
  const [status, setStatus] = useState('Idle');
  const [transcript, setTranscript] = useState('');
  const audioCtxRef = useRef(null);
  const clientRef = useRef(null);
  const modeRef = useRef(null); // 'mic' | 'audio'

  // 공통 콜백
  const handleStatus = useCallback((msg) => {
    setStatus(msg);
    // console.debug(msg);
  }, []);

  const handleTranscript = useCallback((text) => {
    // 텍스트 로그 누적
    setTranscript((prev) => (prev ? `${prev}\n${text.trim()}` : text.trim()));
  }, []);

  // 공용 AudioContext (한 번만 생성)
  const ensureAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }, []);

  // 현재 클라이언트 정리
  const destroyClient = useCallback(async () => {
    try {
      if (clientRef.current) {
        await clientRef.current.stop?.();
      }
    } catch {}
    clientRef.current = null;
    modeRef.current = null;
  }, []);

  // 마이크 STT 시작
  const startMicSTT = useCallback(async () => {
    await destroyClient();
    const ctx = ensureAudioContext();

    // 마이크는 stt_client가 getUserMedia를 내부에서 처리하도록 audioNode를 생략
    clientRef.current = new RealtimeSTTClient({
      wsUrl,
      threshold,          // 0.015~0.03에서 조정
      blockMs: 10,
      silenceWindowMs: 500,
      minSpeechMs: 250,
      context: ctx,
      onStatus: handleStatus,
      onTranscript: handleTranscript,
    });
    await clientRef.current.init();
    await clientRef.current.start();
    modeRef.current = 'mic';
  }, [destroyClient, ensureAudioContext, handleStatus, handleTranscript, threshold, wsUrl]);

  // <audio> 요소 기반 STT 시작
  const startAudioSTT = useCallback(async (audioElement) => {
    if (!(audioElement instanceof HTMLMediaElement)) {
      throw new Error('startAudioSTT(audioElement): 올바른 <audio> 또는 <video> 요소를 전달하세요.');
    }
    await destroyClient();
    const ctx = ensureAudioContext();

    // 재생 소스 노드 생성
    const node = new MediaElementAudioSourceNode(ctx, { mediaElement: audioElement });

    clientRef.current = new RealtimeSTTClient({
      wsUrl,
      threshold,
      blockMs: 10,
      silenceWindowMs: 500,
      minSpeechMs: 250,
      context: ctx,
      audioNode: node,
      onStatus: handleStatus,
      onTranscript: handleTranscript,
    });
    await clientRef.current.init();
    await clientRef.current.start();
    modeRef.current = 'audio';
  }, [destroyClient, ensureAudioContext, handleStatus, handleTranscript, threshold, wsUrl]);

  // 중단
  const stopSTT = useCallback(async () => {
    if (clientRef.current) {
      await clientRef.current.stop();
      setStatus('🛑 Stopped');
    }
    modeRef.current = null;
  }, []);

  // 언마운트/탭 이동 등 정리
  useEffect(() => {
    const onVis = () => {
      if (document.hidden && clientRef.current) {
        // 탭 백그라운드에서 마이크/오디오 캡처 이슈 방지
        clientRef.current.stop?.();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      destroyClient();
      try { audioCtxRef.current?.close(); } catch {}
      audioCtxRef.current = null;
    };
  }, [destroyClient]);

  // 유틸: 로그 비우기
  const clearTranscript = useCallback(() => setTranscript(''), []);

  return {
    status,
    transcript,
    startMicSTT,
    startAudioSTT,
    stopSTT,
    clearTranscript,
  };
}

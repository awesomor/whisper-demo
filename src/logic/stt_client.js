/**
 * 실시간 STT 데모용 클라이언트 모듈
 * - 0.01s 블록 단위로 누적
 * - 최근 0.5s 평균 RMS < THRESHOLD 면 구간 종료
 * - 종료 시 구간을 WAV(16kHz/mono/16-bit)로 인코딩해 WS로 전송
 * - 서버는 "WAV 바이트 1건 수신 → 텍스트 1건 반환" 단발 WebSocket 프로토콜 가정
 */

export class RealtimeSTTClient {
  /**
   * @param {{
   *   wsUrl: string,                     // Whisper WS 서버 (예: "ws://114.110.128.184:31376/ws")
   *   audioNode?: AudioNode,             // 이미 만든 AudioNode(예: MediaElementAudioSourceNode). 없으면 마이크 사용
   *   onTranscript?: (text:string)=>void,// 서버 응답 수신 콜백
   *   onStatus?: (msg:string)=>void,     // 상태 메시지 콜백
   *   context?: AudioContext,            // 재사용할 AudioContext (옵션)
   *   threshold?: number,                // RMS 임계값 (기본 0.015~0.03 사이부터 시작)
   *   blockMs?: number,                  // 블록 길이(ms) 기본 10ms
   *   silenceWindowMs?: number,          // 무음 판정 창(ms) 기본 500ms
   *   minSpeechMs?: number,              // 최소 발화 길이(ms) 기본 200ms
   *   maxSegmentMs?: number              // 한 세그먼트 최대 길이(ms) 기본 20_000
   * }} cfg
   */
  constructor(cfg) {
    this.wsUrl = cfg.wsUrl;
    this.onTranscript = cfg.onTranscript || (()=>{});
    this.onStatus = cfg.onStatus || (()=>{});

    // ====== VAD-like 파라미터 ======
    this.threshold = cfg.threshold ?? 0.02;   // 프로젝트/환경에 따라 0.015~0.03 추천
    this.blockMs = cfg.blockMs ?? 10;         // 0.01초
    this.silenceWindowMs = cfg.silenceWindowMs ?? 500; // 0.5초
    this.minSpeechMs = cfg.minSpeechMs ?? 200;
    this.maxSegmentMs = cfg.maxSegmentMs ?? 20_000;

    // ====== 오디오/워크렛 ======
    this.ctx = cfg.context || new (window.AudioContext || window.webkitAudioContext)();
    this.audioNode = cfg.audioNode ?? null;   // 없으면 마이크로 생성
    this.workletNode = null;

    // 누적 버퍼들
    this.currentSegment = [];   // Float32Array 조각들 (원샘플레이트)
    this.currentLength = 0;     // 샘플 개수
    this.segmentStartTime = 0;

    // 블록/RMS 윈도우
    this.blockTargetSamples = Math.round(this.ctx.sampleRate * (this.blockMs / 1000));
    this.blockCarry = null;     // 블록 경계 보정용
    this.rmsWindow = [];        // 최근 블록 RMS 기록
    this.rmsWindowSize = Math.max(1, Math.round(this.silenceWindowMs / this.blockMs)); // 500/10=50

    // WS 1회성 연결(보낼 때마다 새로 열고 닫는다) — 서버가 단발 파일→텍스트 응답이므로
    this._wsBusy = false;

    // 상태
    this._running = false;
  }

  /** 초기화: AudioWorklet 로드 + 입력 소스 확보 */
  async init() {
    // 워크렛 등록
    const workletUrl = new URL('./frame-capture-processor.js', import.meta.url);
    await this.ctx.audioWorklet.addModule(workletUrl);

    // 입력 소스(없으면 마이크)
    if (!this.audioNode) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      const src = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: stream });
      this.audioNode = src;
    }

    // 워크렛 노드
    this.workletNode = new AudioWorkletNode(this.ctx, 'frame-capture-processor');
    this.workletNode.port.onmessage = (ev) => this._onAudioBlock(ev.data);

    // 파형 등 기존 UI에 이미 연결돼 있다면 ‘병렬 탭’으로 분기만 걸어준다
    this.audioNode.connect(this.workletNode);
  }

  /** 시작 */
  async start() {
    if (this._running) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this._running = true;
    this.currentSegment = [];
    this.currentLength = 0;
    this.segmentStartTime = performance.now();
    this.rmsWindow = [];
    this.blockCarry = null;

    this.onStatus('🎙️ STT 분할 시작');
  }

  /** 정지(남은 구간도 마무리 전송) */
  async stop() {
    if (!this._running) return;
    this._running = false;

    // 진행 중 세그먼트가 있으면 마무리
    if (this.currentLength > 0) {
      await this._finalizeAndSend();
    }
    this.onStatus('🛑 STT 분할 정지');
  }

  // ===== 내부 로직 =====

  _onAudioBlock(floatBlock /* Float32Array at ctx.sampleRate */) {
    if (!this._running) return;

    // 블록 경계 10ms로 맞추기 (워크렛 chunk 크기가 가변일 수 있으니 0.01s로 재조합)
    let src = floatBlock;
    if (this.blockCarry) {
      // carry와 합쳐서 처리
      const merged = new Float32Array(this.blockCarry.length + src.length);
      merged.set(this.blockCarry, 0);
      merged.set(src, this.blockCarry.length);
      src = merged;
      this.blockCarry = null;
    }

    let offset = 0;
    while (offset + this.blockTargetSamples <= src.length) {
      const block = src.subarray(offset, offset + this.blockTargetSamples);
      this._consumeFixedBlock(block);
      offset += this.blockTargetSamples;
    }

    // 남는 조각은 carry로 보관
    if (offset < src.length) {
      this.blockCarry = src.subarray(offset).slice();
    }
  }

  _consumeFixedBlock(block /* Float32Array (exact 10ms) */) {
    // 누적(원 샘플레이트 그대로)
    this.currentSegment.push(block);
    this.currentLength += block.length;

    // RMS 계산
    let sum = 0;
    for (let i = 0; i < block.length; i++) {
      const v = block[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / block.length);

    // RMS 윈도우 업데이트
    this.rmsWindow.push(rms);
    if (this.rmsWindow.length > this.rmsWindowSize) {
      this.rmsWindow.shift();
    }

    // 무음 판정 (최근 0.5초 평균)
    const avgRms = this.rmsWindow.reduce((a, b) => a + b, 0) / this.rmsWindow.length;

    const elapsedMs = performance.now() - this.segmentStartTime;
    const longEnough = elapsedMs >= this.minSpeechMs;
    const tooLong = elapsedMs >= this.maxSegmentMs;

    if ((longEnough && avgRms < this.threshold) || tooLong) {
      // 구간 종료
      this._finalizeAndSend();
      // 다음 세그먼트 준비
      this.currentSegment = [];
      this.currentLength = 0;
      this.segmentStartTime = performance.now();
      this.rmsWindow = [];
    }
  }

  async _finalizeAndSend() {
    const srIn = this.ctx.sampleRate;
    const mono = this._concatFloat32(this.currentSegment, this.currentLength);
    // WAV는 16kHz/mono/16-bit로 보냄
    const wavBlob = await this._floatToWav16kMono(mono, srIn);

    try {
      this.onStatus(`📤 세그먼트 전송 (${(wavBlob.size/1024).toFixed(1)} KB)`);
      const text = await this._postWavViaWebSocket(wavBlob);
      if (text && text.trim()) {
        this.onTranscript(text);
      } else {
        this.onStatus('ℹ️ 서버 응답이 비어있음');
      }
    } catch (e) {
      this.onStatus('⚠️ 전송/수신 실패: ' + (e?.message || e));
    }
  }

  _concatFloat32(chunks, totalLen) {
    const out = new Float32Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  async _floatToWav16kMono(floatData, srcRate) {
    // OfflineAudioContext로 16kHz 재샘플
    const targetRate = 16000;
    if (srcRate === targetRate) {
      return this._encodeWavPCM16(floatData, targetRate);
    }

    // 1) src 버퍼 채우기
    const srcBuf = new AudioBuffer({ length: floatData.length, numberOfChannels: 1, sampleRate: srcRate });
    srcBuf.copyToChannel(floatData, 0, 0);

    // 2) 오프라인 렌더로 리샘플
    const duration = srcBuf.length / srcRate;
    const framesOut = Math.ceil(duration * targetRate);
    const offline = new OfflineAudioContext(1, framesOut, targetRate);

    const srcNode = new AudioBufferSourceNode(offline, { buffer: srcBuf });
    srcNode.connect(offline.destination);
    srcNode.start();

    const rendered = await offline.startRendering();
    const out = new Float32Array(rendered.length);
    rendered.copyFromChannel(out, 0, 0);

    return this._encodeWavPCM16(out, targetRate);
  }

  _encodeWavPCM16(float32, sampleRate) {
    // Float32 [-1,1] -> int16
    const len = float32.length;
    const bytesPerSample = 2;
    const blockAlign = 1 * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = len * bytesPerSample;
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    this._writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this._writeAscii(view, 8, 'WAVE');

    // fmt chunk
    this._writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);            // AudioFormat (1 = PCM)
    view.setUint16(22, 1, true);            // NumChannels (mono)
    view.setUint32(24, sampleRate, true);   // SampleRate
    view.setUint32(28, byteRate, true);     // ByteRate
    view.setUint16(32, blockAlign, true);   // BlockAlign
    view.setUint16(34, 16, true);           // BitsPerSample

    // data chunk
    this._writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // PCM samples
    let offset = 44;
    for (let i = 0; i < len; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  _writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  _postWavViaWebSocket(wavBlob) {
    return new Promise((resolve, reject) => {
      if (this._wsBusy) {
        // 단발 서버 가정: 동시 전송 방지
        return reject(new Error('WebSocket busy — 이전 요청 처리 중'));
      }
      this._wsBusy = true;

      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = 'arraybuffer';

      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        this._wsBusy = false;
        reject(new Error('WebSocket timeout'));
      }, 30_000); // 30s

      ws.onopen = async () => {
        try {
          const arr = await wavBlob.arrayBuffer();
          ws.send(arr);
        } catch (e) {
          clearTimeout(timer);
          this._wsBusy = false;
          try { ws.close(); } catch {}
          reject(e);
        }
      };

      ws.onerror = (ev) => {
        clearTimeout(timer);
        this._wsBusy = false;
        reject(new Error('WebSocket error'));
      };

      ws.onmessage = (ev) => {
        clearTimeout(timer);
        this._wsBusy = false;
        try { ws.close(); } catch {}

        // 서버가 텍스트 문자열 또는 JSON을 보낼 수 있다고 가정
        if (typeof ev.data === 'string') {
          // 문자열이면 그대로 사용
          resolve(ev.data);
        } else {
          // ArrayBuffer/Blob이면 시도해서 텍스트로
          if (ev.data instanceof Blob) {
            ev.data.text().then(resolve).catch(reject);
          } else if (ev.data instanceof ArrayBuffer) {
            const dec = new TextDecoder();
            resolve(dec.decode(new Uint8Array(ev.data)));
          } else {
            resolve('');
          }
        }
      };

      ws.onclose = () => {
        // onmessage에서 이미 처리됨
      };
    });
  }
}

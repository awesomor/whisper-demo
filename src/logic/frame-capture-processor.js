/* global registerProcessor */

class FrameCaptureProcessor extends AudioWorkletProcessor {
  // 128 샘플 단위로 들어옴(환경마다 다름). main thread에 PCM Float32 블록을 보낸다.
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // mono 다운믹스
    const ch0 = input[0];
    const ch1 = input[1];
    const len = ch0.length;
    const mono = new Float32Array(len);

    if (ch1) {
      for (let i = 0; i < len; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    } else {
      mono.set(ch0);
    }

    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor('frame-capture-processor', FrameCaptureProcessor);

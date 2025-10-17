import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

export default function WavePlayer() {
  const containerRef = useRef(null);
  const wavesurferRef = useRef(null);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "var(--wave-color)",
      progressColor: "var(--progress-color)",
      cursorColor: "var(--cursor-color)",
      normalize: true,
      height: 120,
      responsive: true,
    });
    wavesurferRef.current = ws;

    ws.on("ready", () => {
      setIsReady(true);
    });

    ws.on("finish", () => {
      setIsPlaying(false);
    });

    // try loading demo file if exists
    fetch("/demo.wav", { method: "HEAD" })
      .then((res) => {
        if (res.ok) ws.load("/demo.wav");
      })
      .catch(() => {});

    return () => {
      ws.destroy();
    };
  }, []);

  const togglePlay = () => {
    if (!wavesurferRef.current) return;
    wavesurferRef.current.playPause();
    setIsPlaying((prev) => !prev);
  };

  return (
    <div className="w-full max-w-3xl p-4 bg-white rounded-xl shadow">
      <div ref={containerRef} className="w-full bg-gray-200 rounded mb-3" />
      <button
        onClick={togglePlay}
        disabled={!isReady}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        {isPlaying ? "Pause" : "Play"}
      </button>
    </div>
  );
}

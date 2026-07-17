import { useEffect, useRef } from "react";

import { mountCellularAutomata } from "./lib/cellular-automata";

export default function Page() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLElement>(null);
  const statusTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const controls = controlsRef.current;
    const status = statusRef.current;
    const statusText = statusTextRef.current;

    if (canvas === null || controls === null || status === null || statusText === null) {
      return;
    }

    return mountCellularAutomata({ canvas, controls, status, statusText });
  }, []);

  return (
    <main id="app">
      <canvas
        id="viewport"
        ref={canvasRef}
        aria-label="3D cellular automata viewport"
      />
      <aside id="controls" ref={controlsRef} aria-label="Simulation controls" />
      <section
        id="status"
        ref={statusRef}
        role="status"
        aria-live="polite"
        data-state="loading"
      >
        <span className="status-mark" />
        <span id="status-text" ref={statusTextRef}>
          Starting WebGPU
        </span>
      </section>
    </main>
  );
}

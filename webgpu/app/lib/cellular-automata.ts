import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Circle,
  createIcons,
  Dices,
  Pause,
  Play,
  RotateCcw,
  Square,
  StepForward,
  Trash2,
} from 'lucide';

import { GpuAutomaton } from './automaton';
import { CellStyle, GpuCellRenderer } from './cell-renderer';
import {
  getPreset,
  maskFromCounts,
  parseCounts,
  RULE_PRESETS,
  type ColorMode,
  type RulePreset,
} from './rules';
import type { AutomatonRule, Neighborhood } from './sim/reference';

const ICONS = { Circle, Dices, Pause, Play, RotateCcw, Square, StepForward, Trash2 };
const DEFAULT_TICK_RATE = 10;
const MAX_TICK_RATE = 150;
const MAX_STEPS_PER_FRAME = 32;
const TICK_RATE_SLIDER_MAX = 1_000;
const DEFAULT_RECORD_GENERATIONS = 1_000;
const MAX_RECORD_GENERATIONS = 100_000;
const MIN_RECORDING_DURATION_MS = 500;
const RECORDING_BITS_PER_PIXEL = 0.08;
const MIN_RECORDING_BITRATE = 4_000_000;
const MAX_RECORDING_BITRATE = 20_000_000;
const RECORDING_MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

type ViewAspect = 'fill' | '16:9' | '4:3' | '1:1' | '9:16';

const VIEW_ASPECT_RATIOS: Record<ViewAspect, number | null> = {
  fill: null,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
  '9:16': 9 / 16,
};

interface ActiveRecording {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Blob[];
  readonly startGeneration: number;
  readonly targetGeneration: number;
  readonly requestedGenerations: number;
  readonly mimeType: string;
  readonly minimumStopTime: number;
  readonly frameTrack: CanvasCaptureMediaStreamTrack | null;
  readonly frameInterval: number;
  downloadOnStop: boolean;
  finalFrameRendered: boolean;
  finalFrameStopTime: number | null;
  errorMessage: string | null;
  nextFrameTime: number;
  stopping: boolean;
}

export interface CellularAutomataElements {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  controls: HTMLElement;
  status: HTMLElement;
  statusText: HTMLElement;
}

function tickRateFromSlider(value: number): number {
  const exponent = THREE.MathUtils.clamp(value, 0, TICK_RATE_SLIDER_MAX) / TICK_RATE_SLIDER_MAX;
  return Math.round(MAX_TICK_RATE ** exponent);
}

function sliderFromTickRate(value: number): number {
  const rate = THREE.MathUtils.clamp(value, 1, MAX_TICK_RATE);
  return Math.round((Math.log(rate) / Math.log(MAX_TICK_RATE)) * TICK_RATE_SLIDER_MAX);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

class CellularAutomataApp {
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 20);
  private readonly orbit: OrbitControls;
  private readonly automaton: GpuAutomaton;
  private readonly cellStyle = new CellStyle();
  private readonly resizeObserver: ResizeObserver;

  private cellRenderer: GpuCellRenderer | null = null;
  private rule: AutomatonRule = getPreset('builder');
  private running = true;
  private tickRate = DEFAULT_TICK_RATE;
  private accumulator = 0;
  private lastFrameTime = performance.now();
  private lastMetricsTime = 0;
  private frameCount = 0;
  private metricStepCount = 0;
  private fps = 0;
  private simulationTps = 0;
  private seedDensity = 0.55;
  private seedRadius = 6;
  private bounds = 64;
  private renderScale = 1;
  private viewAspect: ViewAspect = 'fill';
  private recording: ActiveRecording | null = null;
  private recordingUrl: string | null = null;
  private recordRestartAllowedAt = 0;
  private disposed = false;

  private constructor(renderer: THREE.WebGPURenderer, elements: CellularAutomataElements) {
    this.renderer = renderer;
    this.stage = elements.stage;
    this.canvas = elements.canvas;
    this.panel = elements.controls;
    this.status = elements.status;
    this.statusText = elements.statusText;
    this.automaton = new GpuAutomaton(renderer);

    this.scene.background = new THREE.Color('#a6e6f5');
    this.camera.position.set(1.15, 0.85, 1.35);

    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.target.set(0, 0, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.055;
    this.orbit.enablePan = false;
    this.orbit.minDistance = 0.9;
    this.orbit.maxDistance = 4;
    this.orbit.autoRotate = true;
    this.orbit.autoRotateSpeed = 0.45;
    this.orbit.update();

    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.505, -0.505, -0.505),
      new THREE.Vector3(0.505, 0.505, 0.505),
    );
    const boundsHelper = new THREE.Box3Helper(bounds, new THREE.Color('#4d5557'));
    this.scene.add(boundsHelper);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.watchRendererErrors();
  }

  static async create(elements: CellularAutomataElements): Promise<CellularAutomataApp> {
    if (!window.isSecureContext) {
      throw new Error('WebGPU requires HTTPS or localhost.');
    }
    if (navigator.gpu === undefined) {
      throw new Error('WebGPU is unavailable in this browser or on this GPU.');
    }

    const renderer = new THREE.WebGPURenderer({
      canvas: elements.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    try {
      await renderer.init();
    } catch (error) {
      renderer.dispose();
      console.error(error);
      throw new Error('WebGPU could not initialize on this GPU.');
    }

    try {
      return new CellularAutomataApp(renderer, elements);
    } catch (error) {
      renderer.dispose();
      throw error;
    }
  }

  start(): void {
    this.buildPanel();
    this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    this.automaton.rebuild(this.bounds, this.rule);
    this.rebuildCellRenderer();
    this.resize();
    this.setStatus('WebGPU resident', 'ready');
    this.renderer.setAnimationLoop((time) => this.animate(time));
  }

  private element<T extends HTMLElement>(id: string): T {
    const value = this.panel.querySelector<HTMLElement>(`#${id}`);
    if (value === null) {
      throw new Error(`Missing required control #${id}`);
    }
    return value as T;
  }

  private buildPanel(): void {
    const presetOptions = RULE_PRESETS.map(
      (preset) => `<option value="${preset.id}"${preset.id === 'builder' ? ' selected' : ''}>${preset.name}</option>`,
    ).join('');

    this.panel.innerHTML = `
      <header class="panel-header">
        <div>
          <p class="eyebrow">GPU LAB</p>
          <h1>Cellular Automata</h1>
        </div>
        <span class="gpu-badge"><span></span> WebGPU</span>
      </header>

      <section class="metrics" aria-label="Performance metrics">
        <div><strong id="metric-generation">0</strong><span>generation</span></div>
        <div><strong id="metric-tps">0</strong><span>queued tps</span></div>
        <div><strong id="metric-fps">0</strong><span>fps</span></div>
        <div><strong id="metric-cells">262k</strong><span>cells / tick</span></div>
      </section>

      <section class="control-section recording-section">
        <div class="section-heading">
          <h2>Recording</h2>
          <span id="record-dimensions">-- x --</span>
        </div>
        <div class="field-grid">
          <label class="field">
            <span>Generations</span>
            <input id="record-generations" type="number" min="1" max="${MAX_RECORD_GENERATIONS}" step="1" value="${DEFAULT_RECORD_GENERATIONS}" />
          </label>
          <label class="field">
            <span>FPS</span>
            <select id="record-fps">
              <option value="30">30</option>
              <option value="60" selected>60</option>
            </select>
          </label>
        </div>
        <div class="field-grid">
          <label class="field">
            <span>Aspect</span>
            <select id="view-aspect">
              <option value="fill" selected>Fill viewport</option>
              <option value="16:9">16:9</option>
              <option value="4:3">4:3</option>
              <option value="1:1">1:1</option>
              <option value="9:16">9:16</option>
            </select>
          </label>
          <label class="toggle-field">
            <span>Start at zero</span>
            <input id="record-reset" type="checkbox" checked />
          </label>
        </div>
        <div class="recording-actions">
          <button id="record" class="record-button" type="button">
            <i data-lucide="circle"></i>
            <span id="record-button-label">Record</span>
          </button>
          <div class="recording-progress">
            <div><span id="record-state">ready</span><output id="record-progress-value">0 / ${formatInteger(DEFAULT_RECORD_GENERATIONS)}</output></div>
            <progress id="record-progress" max="${DEFAULT_RECORD_GENERATIONS}" value="0"></progress>
          </div>
          <a id="record-download" class="record-download" hidden>Save video</a>
        </div>
      </section>

      <section class="control-section">
        <div class="section-heading"><h2>Simulation</h2><span id="run-state">running</span></div>
        <div class="transport" role="toolbar" aria-label="Playback controls">
          <button id="toggle-run" class="primary icon-button" type="button" title="Pause" aria-label="Pause">
            <i data-lucide="pause"></i>
          </button>
          <button id="step" class="icon-button" type="button" title="Step one generation" aria-label="Step one generation">
            <i data-lucide="step-forward"></i>
          </button>
          <button id="reset" class="icon-button" type="button" title="Reset simulation" aria-label="Reset simulation">
            <i data-lucide="rotate-ccw"></i>
          </button>
          <button id="reseed" class="icon-button" type="button" title="New random seed" aria-label="New random seed">
            <i data-lucide="dices"></i>
          </button>
          <button id="clear" class="icon-button danger" type="button" title="Clear cells" aria-label="Clear cells">
            <i data-lucide="trash-2"></i>
          </button>
        </div>

        <label class="field full-field">
          <span>Preset</span>
          <select id="preset">${presetOptions}<option value="custom">Custom</option></select>
        </label>

        <label class="field full-field">
          <span>Grid</span>
          <select id="bounds">
            <option value="32">32³</option>
            <option value="48">48³</option>
            <option value="64" selected>64³</option>
            <option value="96">96³</option>
            <option value="128">128³</option>
            <option value="160">160³</option>
          </select>
        </label>

        <label class="range-field">
          <span><span>Ticks / sec</span><output id="tick-rate-value">${DEFAULT_TICK_RATE}</output></span>
          <input id="tick-rate" type="range" min="0" max="${TICK_RATE_SLIDER_MAX}" step="1" value="${sliderFromTickRate(DEFAULT_TICK_RATE)}" />
        </label>

        <label class="range-field">
          <span><span>Seed density</span><output id="density-value">55%</output></span>
          <input id="seed-density" type="range" min="0.05" max="0.95" step="0.01" value="0.55" />
        </label>
        <label class="range-field">
          <span><span>Seed radius</span><output id="radius-value">6</output></span>
          <input id="seed-radius" type="range" min="2" max="24" step="1" value="6" />
        </label>
      </section>

      <section class="control-section">
        <div class="section-heading"><h2>Rule</h2><span id="rule-code">S269 / B468910 / 10</span></div>
        <div class="field-grid">
          <label class="field">
            <span>Survival</span>
            <input id="survival" type="text" inputmode="numeric" value="2, 6, 9" />
          </label>
          <label class="field">
            <span>Birth</span>
            <input id="birth" type="text" inputmode="numeric" value="4, 6, 8, 9, 10" />
          </label>
        </div>
        <label class="field full-field compact-number">
          <span>Decay states</span>
          <input id="states" type="number" min="1" max="50" step="1" value="10" />
        </label>
        <div class="segmented" role="group" aria-label="Neighbourhood">
          <button type="button" class="selected" data-neighborhood="moore26" aria-pressed="true">Moore 26</button>
          <button type="button" data-neighborhood="vonNeumann6" aria-pressed="false">Von Neumann 6</button>
        </div>
      </section>

      <section class="control-section appearance-section">
        <div class="section-heading"><h2>Appearance</h2></div>
        <label class="field full-field">
          <span>Color mapping</span>
          <select id="color-mode">
            <option value="distance">Distance to center</option>
            <option value="state">Cell state</option>
          </select>
        </label>
        <div class="field-grid color-grid">
          <label class="color-field"><span id="color-low-label">Center</span><input id="color-low" type="color" value="#ffff00" /></label>
          <label class="color-field"><span id="color-high-label">Edge</span><input id="color-high" type="color" value="#ff0000" /></label>
        </div>
        <label class="range-field">
          <span><span>Cell size</span><output id="cell-scale-value">90%</output></span>
          <input id="cell-scale" type="range" min="0.55" max="1" step="0.01" value="0.9" />
        </label>
        <div class="field-grid">
          <label class="field">
            <span>Resolution</span>
            <select id="render-scale">
              <option value="0.75">75%</option>
              <option value="1" selected>100%</option>
              <option value="1.25">125%</option>
            </select>
          </label>
          <label class="toggle-field">
            <span>Auto orbit</span>
            <input id="auto-orbit" type="checkbox" checked />
          </label>
        </div>
      </section>
    `;

    this.refreshIcons();
    this.bindPanelEvents();
    this.loadPreset(getPreset('builder'));
  }

  private bindPanelEvents(): void {
    this.element<HTMLButtonElement>('toggle-run').addEventListener('click', () => this.setRunning(!this.running));
    this.element<HTMLButtonElement>('step').addEventListener('click', () => {
      if (this.running) {
        this.setRunning(false);
      }
      this.advanceSimulation();
    });
    this.element<HTMLButtonElement>('reset').addEventListener('click', () => {
      this.automaton.reset(1);
      this.refreshCells();
    });
    this.element<HTMLButtonElement>('reseed').addEventListener('click', () => {
      this.automaton.reset();
      this.refreshCells();
    });
    this.element<HTMLButtonElement>('clear').addEventListener('click', () => {
      this.automaton.clear();
      this.refreshCells();
    });

    this.element<HTMLSelectElement>('preset').addEventListener('change', (event) => {
      const id = (event.currentTarget as HTMLSelectElement).value;
      if (id !== 'custom') {
        this.loadPreset(getPreset(id));
        this.applyRuleFromPanel();
      }
    });

    this.element<HTMLSelectElement>('bounds').addEventListener('change', (event) => {
      this.bounds = Number((event.currentTarget as HTMLSelectElement).value);
      this.seedRadius = Math.min(this.seedRadius, Math.floor(this.bounds / 2));
      const radius = this.element<HTMLInputElement>('seed-radius');
      radius.max = String(Math.floor(this.bounds / 2));
      radius.value = String(this.seedRadius);
      this.element<HTMLOutputElement>('radius-value').value = String(this.seedRadius);
      this.rebuildAutomaton();
    });

    this.element<HTMLInputElement>('tick-rate').addEventListener('input', (event) => {
      const sliderValue = Number((event.currentTarget as HTMLInputElement).value);
      this.tickRate = tickRateFromSlider(sliderValue);
      this.element<HTMLOutputElement>('tick-rate-value').value = formatInteger(this.tickRate);
      this.accumulator = 0;
    });

    const recordGenerations = this.element<HTMLInputElement>('record-generations');
    recordGenerations.addEventListener('input', () => {
      const generations = Number(recordGenerations.value);
      const valid = Number.isSafeInteger(generations) && generations >= 1 && generations <= MAX_RECORD_GENERATIONS;
      recordGenerations.classList.toggle('invalid', !valid);
      recordGenerations.setAttribute('aria-invalid', String(!valid));
      if (!valid || this.recording !== null) {
        return;
      }

      const progress = this.element<HTMLProgressElement>('record-progress');
      progress.max = generations;
      progress.value = 0;
      this.element<HTMLOutputElement>('record-progress-value').value = `0 / ${formatInteger(generations)}`;
    });
    this.element<HTMLSelectElement>('view-aspect').addEventListener('change', (event) => {
      const aspect = (event.currentTarget as HTMLSelectElement).value as ViewAspect;
      if (!(aspect in VIEW_ASPECT_RATIOS)) {
        return;
      }

      this.viewAspect = aspect;
      this.resize();
    });

    const recordButton = this.element<HTMLButtonElement>('record');
    recordButton.addEventListener('click', () => {
      if (this.recording === null) {
        if (performance.now() >= this.recordRestartAllowedAt) {
          this.startRecording();
        }
      } else {
        this.stopRecording(true);
      }
    });
    if (typeof this.canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      recordButton.disabled = true;
      recordButton.title = 'Canvas recording is unavailable in this browser';
    }

    const density = this.element<HTMLInputElement>('seed-density');
    density.addEventListener('input', () => {
      this.seedDensity = Number(density.value);
      this.element<HTMLOutputElement>('density-value').value = `${Math.round(this.seedDensity * 100)}%`;
      this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    });
    density.addEventListener('change', () => {
      this.automaton.reset();
      this.refreshCells();
    });

    const radius = this.element<HTMLInputElement>('seed-radius');
    radius.addEventListener('input', () => {
      this.seedRadius = Number(radius.value);
      this.element<HTMLOutputElement>('radius-value').value = String(this.seedRadius);
      this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    });
    radius.addEventListener('change', () => {
      this.automaton.reset();
      this.refreshCells();
    });

    for (const id of ['survival', 'birth', 'states']) {
      this.element<HTMLInputElement>(id).addEventListener('change', () => {
        this.element<HTMLSelectElement>('preset').value = 'custom';
        this.applyRuleFromPanel();
      });
    }

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-neighborhood]')) {
      button.addEventListener('click', () => {
        for (const sibling of this.panel.querySelectorAll('[data-neighborhood]')) {
          sibling.classList.toggle('selected', sibling === button);
          sibling.setAttribute('aria-pressed', String(sibling === button));
        }
        this.element<HTMLSelectElement>('preset').value = 'custom';
        this.applyRuleFromPanel();
      });
    }

    const updateColors = (): void => {
      this.cellStyle.setColors(
        this.element<HTMLInputElement>('color-low').value,
        this.element<HTMLInputElement>('color-high').value,
      );
    };
    this.element<HTMLInputElement>('color-low').addEventListener('input', updateColors);
    this.element<HTMLInputElement>('color-high').addEventListener('input', updateColors);
    this.element<HTMLSelectElement>('color-mode').addEventListener('change', (event) => {
      this.applyColorMode((event.currentTarget as HTMLSelectElement).value as ColorMode);
    });

    const cellScale = this.element<HTMLInputElement>('cell-scale');
    cellScale.addEventListener('input', () => {
      this.cellStyle.scale.value = Number(cellScale.value);
      this.element<HTMLOutputElement>('cell-scale-value').value = `${Math.round(
        this.cellStyle.scale.value * 100,
      )}%`;
    });

    this.element<HTMLSelectElement>('render-scale').addEventListener('change', (event) => {
      this.renderScale = Number((event.currentTarget as HTMLSelectElement).value);
      this.resize();
    });
    this.element<HTMLInputElement>('auto-orbit').addEventListener('change', (event) => {
      this.orbit.autoRotate = (event.currentTarget as HTMLInputElement).checked;
    });
  }

  private loadPreset(preset: RulePreset): void {
    this.element<HTMLInputElement>('survival').value = preset.survival.join(', ');
    this.element<HTMLInputElement>('birth').value = preset.birth.join(', ');
    this.element<HTMLInputElement>('states').value = String(preset.states);
    this.element<HTMLSelectElement>('color-mode').value = preset.colorMode;
    this.element<HTMLInputElement>('color-low').value = preset.colorLow;
    this.element<HTMLInputElement>('color-high').value = preset.colorHigh;
    this.cellStyle.setColors(preset.colorLow, preset.colorHigh);
    this.applyColorMode(preset.colorMode);

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-neighborhood]')) {
      const selected = button.dataset.neighborhood === preset.neighborhood;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    this.rule = preset;
    this.updateRuleCode(preset.survival, preset.birth, preset.states);
  }

  private applyColorMode(mode: ColorMode): void {
    this.cellStyle.setColorMode(mode);
    this.element<HTMLElement>('color-low-label').textContent = mode === 'distance' ? 'Center' : 'Decay';
    this.element<HTMLElement>('color-high-label').textContent = mode === 'distance' ? 'Edge' : 'Alive';
  }

  private applyRuleFromPanel(): void {
    const survivalInput = this.element<HTMLInputElement>('survival');
    const birthInput = this.element<HTMLInputElement>('birth');
    const statesInput = this.element<HTMLInputElement>('states');
    const survival = parseCounts(survivalInput.value);
    const birth = parseCounts(birthInput.value);
    const states = Number(statesInput.value);
    const validStates = Number.isInteger(states) && states >= 1 && states <= 50;

    survivalInput.classList.toggle('invalid', survival === null);
    birthInput.classList.toggle('invalid', birth === null);
    statesInput.classList.toggle('invalid', !validStates);
    survivalInput.setAttribute('aria-invalid', String(survival === null));
    birthInput.setAttribute('aria-invalid', String(birth === null));
    statesInput.setAttribute('aria-invalid', String(!validStates));

    if (survival === null || birth === null || !validStates) {
      this.setStatus('Rule needs valid counts', 'error');
      return;
    }

    const selected = this.panel.querySelector<HTMLButtonElement>('[data-neighborhood].selected');
    const neighborhood = (selected?.dataset.neighborhood ?? 'moore26') as Neighborhood;
    this.rule = {
      survivalMask: maskFromCounts(survival),
      birthMask: maskFromCounts(birth),
      states,
      neighborhood,
    };
    this.automaton.applyRule(this.rule);
    this.automaton.reset(1);
    this.refreshCells();
    this.updateRuleCode(survival, birth, states);
    this.setStatus('WebGPU resident', 'ready');
  }

  private updateRuleCode(survival: readonly number[], birth: readonly number[], states: number): void {
    const compact = (counts: readonly number[]): string => counts.join('');
    this.element<HTMLElement>('rule-code').textContent = `S${compact(survival)} / B${compact(birth)} / ${states}`;
  }

  private rebuildAutomaton(): void {
    this.disposeCellRenderer();
    this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    this.automaton.rebuild(this.bounds, this.rule);
    this.rebuildCellRenderer();
    this.accumulator = 0;
  }

  private rebuildCellRenderer(): void {
    this.cellRenderer = new GpuCellRenderer(
      this.renderer,
      this.automaton.textures,
      this.automaton.bounds,
      this.cellStyle,
    );
    this.scene.add(this.cellRenderer.mesh);
    this.refreshCells();
  }

  private refreshCells(): void {
    if (this.cellRenderer === null) {
      return;
    }
    this.cellRenderer.compact(this.automaton.snapshot().textureIndex);
  }

  private disposeCellRenderer(): void {
    if (this.cellRenderer === null) {
      return;
    }
    this.scene.remove(this.cellRenderer.mesh);
    this.cellRenderer.dispose();
    this.cellRenderer = null;
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.accumulator = 0;
    const toggle = this.element<HTMLButtonElement>('toggle-run');
    toggle.title = running ? 'Pause' : 'Play';
    toggle.ariaLabel = running ? 'Pause' : 'Play';
    toggle.innerHTML = `<i data-lucide="${running ? 'pause' : 'play'}"></i>`;
    this.element<HTMLElement>('run-state').textContent = running ? 'running' : 'paused';
    this.refreshIcons(toggle);
  }

  private startRecording(): void {
    const generationsInput = this.element<HTMLInputElement>('record-generations');
    const requestedGenerations = Number(generationsInput.value);
    const validGenerations =
      Number.isSafeInteger(requestedGenerations) &&
      requestedGenerations >= 1 &&
      requestedGenerations <= MAX_RECORD_GENERATIONS;
    generationsInput.classList.toggle('invalid', !validGenerations);
    generationsInput.setAttribute('aria-invalid', String(!validGenerations));
    if (!validGenerations) {
      this.setStatus(`Recording length must be 1-${formatInteger(MAX_RECORD_GENERATIONS)}`, 'error');
      return;
    }

    if (typeof this.canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      this.setStatus('Canvas recording is unavailable in this browser', 'error');
      return;
    }
    this.clearRecordingDownload();

    const resetAtStart = this.element<HTMLInputElement>('record-reset').checked;
    const startGeneration = resetAtStart ? 0 : this.automaton.generation;
    if (startGeneration > Number.MAX_SAFE_INTEGER - requestedGenerations) {
      this.setStatus('Generation target is too large', 'error');
      return;
    }

    const fps = Number(this.element<HTMLSelectElement>('record-fps').value);
    const videoBitsPerSecond = Math.round(
      THREE.MathUtils.clamp(
        this.canvas.width * this.canvas.height * fps * RECORDING_BITS_PER_PIXEL,
        MIN_RECORDING_BITRATE,
        MAX_RECORDING_BITRATE,
      ),
    );

    let stream: MediaStream;
    let frameTrack: CanvasCaptureMediaStreamTrack | null = null;
    try {
      this.renderer.render(this.scene, this.camera);
      stream = this.canvas.captureStream(0);
      const candidateTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
      if (candidateTrack !== undefined && typeof candidateTrack.requestFrame === 'function') {
        frameTrack = candidateTrack;
      } else {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        stream = this.canvas.captureStream(fps);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Recording could not start: ${message}`, 'error');
      return;
    }

    let recorder: MediaRecorder | null = null;
    let recorderError = 'No supported video encoder';
    const supportedMimeTypes = RECORDING_MIME_TYPES.filter((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );
    const recorderOptions: MediaRecorderOptions[] = supportedMimeTypes.map((mimeType) => ({
      mimeType,
      videoBitsPerSecond,
    }));
    recorderOptions.push({ videoBitsPerSecond });
    for (const options of recorderOptions) {
      try {
        const candidate = new MediaRecorder(stream, options);
        candidate.start(1_000);
        recorder = candidate;
        break;
      } catch (error) {
        recorderError = error instanceof Error ? error.message : String(error);
      }
    }
    if (recorder === null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      this.setStatus(`Recording could not start: ${recorderError}`, 'error');
      return;
    }

    const recording: ActiveRecording = {
      recorder,
      stream,
      chunks: [],
      startGeneration,
      targetGeneration: startGeneration + requestedGenerations,
      requestedGenerations,
      mimeType: recorder.mimeType,
      minimumStopTime: performance.now() + MIN_RECORDING_DURATION_MS,
      frameTrack,
      frameInterval: 1_000 / fps,
      downloadOnStop: true,
      finalFrameRendered: false,
      finalFrameStopTime: null,
      errorMessage: null,
      nextFrameTime: performance.now(),
      stopping: false,
    };
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        recording.chunks.push(event.data);
      }
    });
    recorder.addEventListener('error', (event) => {
      const recorderError = (event as Event & { error?: DOMException }).error;
      recording.errorMessage = recorderError?.message ?? 'The browser encoder stopped unexpectedly';
      recording.downloadOnStop = false;
      if (this.recording === recording) {
        this.stopRecording(false);
      }
    });
    recorder.addEventListener('stop', () => this.completeRecording(recording), { once: true });

    this.recording = recording;
    if (resetAtStart) {
      this.automaton.reset(1);
      this.refreshCells();
      this.element<HTMLElement>('metric-generation').textContent = '0';
    }
    this.setRecordingControlsLocked(true);
    this.updateRecordButton(true);
    this.updateRecordingProgress();
    this.accumulator = 0;
    this.setRunning(true);
    this.renderer.render(this.scene, this.camera);
    this.captureRecordingFrame(performance.now(), true);
  }

  private stopRecording(download: boolean): void {
    const recording = this.recording;
    if (recording === null) {
      return;
    }
    if (recording.stopping) {
      return;
    }

    recording.stopping = true;
    recording.downloadOnStop = download;
    this.setRunning(false);
    this.element<HTMLElement>('record-state').textContent = 'finalizing';
    if (recording.recorder.state !== 'inactive') {
      try {
        recording.recorder.stop();
      } catch (error) {
        recording.errorMessage = error instanceof Error ? error.message : String(error);
        recording.downloadOnStop = false;
        this.completeRecording(recording);
      }
    }
  }

  private completeRecording(recording: ActiveRecording): void {
    for (const track of recording.stream.getTracks()) {
      track.stop();
    }
    if (this.recording !== recording) {
      return;
    }

    this.recording = null;
    this.recordRestartAllowedAt = performance.now() + 500;
    this.setRecordingControlsLocked(false);
    this.updateRecordButton(false);
    this.resize();
    const finalGeneration = this.automaton.generation;
    this.element<HTMLElement>('metric-generation').textContent = formatInteger(finalGeneration);
    const recordedGenerations = Math.max(0, finalGeneration - recording.startGeneration);
    const progress = this.element<HTMLProgressElement>('record-progress');
    progress.value = Math.min(recordedGenerations, recording.requestedGenerations);
    this.element<HTMLOutputElement>('record-progress-value').value =
      `${formatInteger(recordedGenerations)} / ${formatInteger(recording.requestedGenerations)}`;

    if (recording.errorMessage !== null) {
      this.element<HTMLElement>('record-state').textContent = 'error';
      this.setStatus(`Recording failed: ${recording.errorMessage}`, 'error');
      return;
    }
    if (!recording.downloadOnStop || this.disposed) {
      this.element<HTMLElement>('record-state').textContent = 'ready';
      return;
    }
    if (recording.chunks.length === 0) {
      this.element<HTMLElement>('record-state').textContent = 'error';
      this.setStatus('Recording failed: the browser returned an empty video', 'error');
      return;
    }

    const mimeType = recording.recorder.mimeType || recording.mimeType || recording.chunks[0].type || 'video/webm';
    const blob = new Blob(recording.chunks, { type: mimeType });
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const preset = this.element<HTMLSelectElement>('preset').value.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const range =
      recording.startGeneration === 0
        ? `${formatInteger(finalGeneration)}g`
        : `${formatInteger(recording.startGeneration)}-${formatInteger(finalGeneration)}g`;
    const filename = `3d-cellular-automata-${preset}-${range.replace(/,/g, '')}.${extension}`;
    this.clearRecordingDownload();
    const url = URL.createObjectURL(blob);
    this.recordingUrl = url;
    const link = this.element<HTMLAnchorElement>('record-download');
    link.href = url;
    link.download = filename;
    link.hidden = false;
    link.click();
    this.element<HTMLElement>('record-state').textContent = 'saved';
    this.setStatus(`Saved ${filename}`, 'ready');
  }

  private clearRecordingDownload(): void {
    if (this.recordingUrl !== null) {
      URL.revokeObjectURL(this.recordingUrl);
      this.recordingUrl = null;
    }
    const link = this.panel.querySelector<HTMLAnchorElement>('#record-download');
    if (link !== null) {
      link.hidden = true;
      link.removeAttribute('href');
      link.removeAttribute('download');
    }
  }

  private setRecordingControlsLocked(locked: boolean): void {
    for (const control of this.panel.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >('button, input, select')) {
      if (control.id === 'record') {
        continue;
      }
      if (locked) {
        control.dataset.recordingWasDisabled = String(control.disabled);
        control.disabled = true;
      } else if (control.dataset.recordingWasDisabled !== undefined) {
        control.disabled = control.dataset.recordingWasDisabled === 'true';
        delete control.dataset.recordingWasDisabled;
      }
    }
  }

  private updateRecordButton(recording: boolean): void {
    const button = this.element<HTMLButtonElement>('record');
    button.classList.toggle('recording', recording);
    button.title = recording ? 'Stop and save recording' : 'Record simulation';
    button.ariaLabel = button.title;
    button.innerHTML = recording
      ? '<i data-lucide="square"></i><span id="record-button-label">Stop</span>'
      : '<i data-lucide="circle"></i><span id="record-button-label">Record</span>';
    this.refreshIcons(button);
  }

  private updateRecordingProgress(): void {
    const recording = this.recording;
    if (recording === null) {
      return;
    }

    const completed = THREE.MathUtils.clamp(
      this.automaton.generation - recording.startGeneration,
      0,
      recording.requestedGenerations,
    );
    const progress = this.element<HTMLProgressElement>('record-progress');
    progress.max = recording.requestedGenerations;
    progress.value = completed;
    this.element<HTMLOutputElement>('record-progress-value').value =
      `${formatInteger(completed)} / ${formatInteger(recording.requestedGenerations)}`;
    this.element<HTMLElement>('record-state').textContent =
      recording.finalFrameRendered || recording.stopping ? 'finalizing' : 'recording';
    this.setStatus(
      `Recording ${formatInteger(completed)} / ${formatInteger(recording.requestedGenerations)}`,
      'loading',
    );
  }

  private captureRecordingFrame(time: number, force = false): void {
    const recording = this.recording;
    if (
      recording === null ||
      recording.stopping ||
      recording.frameTrack === null ||
      (!force && time < recording.nextFrameTime)
    ) {
      return;
    }

    try {
      recording.frameTrack.requestFrame();
      recording.nextFrameTime = time + recording.frameInterval;
    } catch (error) {
      recording.errorMessage = error instanceof Error ? error.message : String(error);
      recording.downloadOnStop = false;
      this.stopRecording(false);
    }
  }

  private cancelRecording(): void {
    const recording = this.recording;
    if (recording === null) {
      return;
    }

    this.recording = null;
    recording.downloadOnStop = false;
    if (recording.recorder.state !== 'inactive') {
      try {
        recording.recorder.stop();
      } catch {
        // The stream is stopped below even if the encoder already tore down.
      }
    }
    for (const track of recording.stream.getTracks()) {
      track.stop();
    }
    if (!this.disposed) {
      this.setRecordingControlsLocked(false);
      this.updateRecordButton(false);
      this.element<HTMLElement>('record-state').textContent = 'ready';
      this.resize();
    }
  }

  private advanceSimulation(count = 1): void {
    this.automaton.step(count);
    this.refreshCells();
    this.metricStepCount += count;
  }

  private animate(time: number): void {
    const delta = Math.min((time - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = time;

    if (this.running) {
      this.accumulator += delta;
      const tickDuration = 1 / this.tickRate;
      let dueSteps = Math.min(Math.floor(this.accumulator / tickDuration), MAX_STEPS_PER_FRAME);
      if (this.recording !== null) {
        const remainingSteps = Math.max(0, this.recording.targetGeneration - this.automaton.generation);
        dueSteps = Math.min(dueSteps, remainingSteps);
      }

      if (dueSteps > 0) {
        this.advanceSimulation(dueSteps);
        this.accumulator -= dueSteps * tickDuration;
      }

      if (dueSteps === MAX_STEPS_PER_FRAME) {
        this.accumulator = Math.min(this.accumulator, tickDuration);
      }
    }

    this.orbit.update(delta);
    this.renderer.render(this.scene, this.camera);
    const recording = this.recording;
    if (recording !== null && !recording.stopping) {
      if (this.automaton.generation >= recording.targetGeneration) {
        if (!recording.finalFrameRendered) {
          recording.finalFrameRendered = true;
          recording.finalFrameStopTime = Math.max(
            recording.minimumStopTime,
            time + recording.frameInterval,
          );
          this.setRunning(false);
          this.captureRecordingFrame(time, true);
        } else {
          this.captureRecordingFrame(time);
        }
        if (
          this.recording === recording &&
          !recording.stopping &&
          recording.finalFrameStopTime !== null &&
          time >= recording.finalFrameStopTime
        ) {
          this.stopRecording(true);
        }
      } else {
        this.captureRecordingFrame(time);
      }
    }
    if (this.recording !== null) {
      this.updateRecordingProgress();
    }
    this.updateMetrics(time);
  }

  private updateMetrics(time: number): void {
    this.frameCount += 1;
    if (this.lastMetricsTime === 0) {
      this.lastMetricsTime = time;
      return;
    }
    if (time - this.lastMetricsTime < 500) {
      return;
    }

    const elapsed = time - this.lastMetricsTime;
    this.fps = (this.frameCount * 1000) / elapsed;
    this.simulationTps = (this.metricStepCount * 1000) / elapsed;
    this.frameCount = 0;
    this.metricStepCount = 0;
    this.lastMetricsTime = time;
    const snapshot = this.automaton.snapshot();

    this.element<HTMLElement>('metric-generation').textContent = formatInteger(snapshot.generation);
    this.element<HTMLElement>('metric-tps').textContent = formatInteger(Math.round(this.simulationTps));
    this.element<HTMLElement>('metric-fps').textContent = this.fps.toFixed(0);
    this.element<HTMLElement>('metric-cells').textContent =
      snapshot.cellCount >= 1_000_000
        ? `${(snapshot.cellCount / 1_000_000).toFixed(1)}m`
        : `${Math.round(snapshot.cellCount / 1000)}k`;
  }

  private resize(): void {
    if (this.recording !== null) {
      return;
    }

    const availableWidth = Math.max(1, this.stage.clientWidth);
    const availableHeight = Math.max(1, this.stage.clientHeight);
    const aspectRatio = VIEW_ASPECT_RATIOS[this.viewAspect];
    let width = availableWidth;
    let height = availableHeight;
    if (aspectRatio !== null) {
      if (availableWidth / availableHeight > aspectRatio) {
        width = Math.max(1, Math.floor(availableHeight * aspectRatio));
      } else {
        height = Math.max(1, Math.floor(availableWidth / aspectRatio));
      }
    }

    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const pixelRatio = Math.min(window.devicePixelRatio * this.renderScale, 2);
    const renderWidth = Math.max(2, Math.floor((width * pixelRatio) / 2) * 2);
    const renderHeight = Math.max(2, Math.floor((height * pixelRatio) / 2) * 2);
    this.renderer.setDrawingBufferSize(renderWidth, renderHeight, 1);
    this.camera.aspect = renderWidth / renderHeight;
    this.camera.updateProjectionMatrix();
    const dimensions = this.panel.querySelector<HTMLElement>('#record-dimensions');
    if (dimensions !== null) {
      dimensions.textContent = `${this.canvas.width} x ${this.canvas.height}`;
    }
  }

  private refreshIcons(root: HTMLElement = this.panel): void {
    createIcons({ icons: ICONS, root });
  }

  private setStatus(message: string, state: 'loading' | 'ready' | 'error'): void {
    this.statusText.textContent = message;
    this.status.dataset.state = state;
  }

  private watchRendererErrors(): void {
    type ErrorInfo = { type: string; message: string };
    type DeviceLostInfo = {
      api: string;
      message: string;
      reason: string | null;
      originalEvent: unknown;
    };
    const runtimeRenderer = this.renderer as unknown as {
      onError: (info: ErrorInfo) => void;
      onDeviceLost: (info: DeviceLostInfo) => void;
    };
    const defaultOnError = runtimeRenderer.onError;
    const defaultOnDeviceLost = runtimeRenderer.onDeviceLost;

    runtimeRenderer.onError = (info) => {
      defaultOnError.call(this.renderer, info);
      this.stopForGpuError(`WebGPU ${info.type}: ${info.message}`);
    };
    runtimeRenderer.onDeviceLost = (info) => {
      defaultOnDeviceLost.call(this.renderer, info);
      this.stopForGpuError('WebGPU device lost. Reload to restart.');
    };
  }

  private stopForGpuError(message: string): void {
    this.cancelRecording();
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.status.setAttribute('role', 'alert');
    this.setStatus(message, 'error');
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRecording();
    this.clearRecordingDownload();
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.orbit.dispose();
    this.disposeCellRenderer();
    this.automaton.dispose();
    this.renderer.dispose();
  }
}

export function mountCellularAutomata(elements: CellularAutomataElements): () => void {
  let app: CellularAutomataApp | null = null;
  let disposed = false;

  void CellularAutomataApp.create(elements)
    .then((createdApp) => {
      if (disposed) {
        createdApp.dispose();
        return;
      }

      app = createdApp;
      app.start();
    })
    .catch((error: unknown) => {
      if (disposed) {
        return;
      }

      app?.dispose();
      app = null;
      const message = error instanceof Error ? error.message : String(error);
      elements.statusText.textContent = message;
      elements.status.dataset.state = 'error';
      elements.status.setAttribute('role', 'alert');
      document.body.classList.add('fatal-error');
      console.error(error);
    });

  return () => {
    if (disposed) {
      return;
    }

    disposed = true;
    app?.dispose();
    document.body.classList.remove('fatal-error');
  };
}

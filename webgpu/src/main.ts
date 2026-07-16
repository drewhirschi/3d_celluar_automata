import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createIcons,
  Dices,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  Trash2,
} from 'lucide';

import { GpuAutomaton } from './automaton';
import { getPreset, maskFromCounts, parseCounts, RULE_PRESETS, type RulePreset } from './rules';
import type { AutomatonRule, Neighborhood } from './sim/reference';
import { createVolumeMaterial, VolumeStyle } from './volume-material';
import './styles.css';

const ICONS = { Dices, Pause, Play, RotateCcw, StepForward, Trash2 };

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return value as T;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

class CellularAutomataApp {
  private readonly canvas = element<HTMLCanvasElement>('viewport');
  private readonly panel = element<HTMLElement>('controls');
  private readonly status = element<HTMLElement>('status');
  private readonly statusText = element<HTMLElement>('status-text');
  private readonly renderer: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 20);
  private readonly orbit: OrbitControls;
  private readonly automaton: GpuAutomaton;
  private readonly volumeStyle = new VolumeStyle();
  private readonly resizeObserver: ResizeObserver;
  private readonly volumeMesh: THREE.Mesh<THREE.BoxGeometry, THREE.NodeMaterial>;

  private volumeMaterials: [THREE.NodeMaterial, THREE.NodeMaterial] | null = null;
  private rule: AutomatonRule = getPreset('builder');
  private running = true;
  private tickRate = 10;
  private accumulator = 0;
  private lastFrameTime = performance.now();
  private lastMetricsTime = 0;
  private frameCount = 0;
  private fps = 0;
  private seedDensity = 0.55;
  private seedRadius = 6;
  private bounds = 64;
  private renderScale = 1;

  private constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    this.automaton = new GpuAutomaton(renderer);

    this.scene.background = new THREE.Color('#101112');
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

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.volumeMesh = new THREE.Mesh(geometry, new THREE.NodeMaterial());
    this.volumeMesh.frustumCulled = false;
    this.scene.add(this.volumeMesh);

    const bounds = new THREE.Box3(new THREE.Vector3(-0.505, -0.505, -0.505), new THREE.Vector3(0.505, 0.505, 0.505));
    const boundsHelper = new THREE.Box3Helper(bounds, new THREE.Color('#4d5557'));
    this.scene.add(boundsHelper);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.watchRendererErrors();
  }

  static async create(): Promise<CellularAutomataApp> {
    if (!window.isSecureContext) {
      throw new Error('WebGPU requires HTTPS or localhost.');
    }
    if (navigator.gpu === undefined) {
      throw new Error('WebGPU is unavailable in this browser or on this GPU.');
    }

    const canvas = element<HTMLCanvasElement>('viewport');
    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.1;
    try {
      await renderer.init();
    } catch (error) {
      throw new Error('WebGPU could not initialize on this GPU.', { cause: error });
    }

    return new CellularAutomataApp(renderer);
  }

  start(): void {
    this.buildPanel();
    this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    this.automaton.rebuild(this.bounds, this.rule);
    this.rebuildVolumeMaterials();
    this.resize();
    this.setStatus('WebGPU resident', 'ready');
    this.renderer.setAnimationLoop((time) => this.animate(time));
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
        <div><strong id="metric-fps">0</strong><span>fps</span></div>
        <div><strong id="metric-cells">262k</strong><span>cells / tick</span></div>
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

        <div class="field-grid">
          <label class="field">
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
          <label class="field">
            <span>Ticks / sec</span>
            <input id="tick-rate" type="number" min="1" max="60" step="1" value="10" />
          </label>
        </div>

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
        <div class="field-grid color-grid">
          <label class="color-field"><span>Decay</span><input id="color-low" type="color" value="#ffe36e" /></label>
          <label class="color-field"><span>Alive</span><input id="color-high" type="color" value="#ff4f78" /></label>
        </div>
        <label class="range-field">
          <span><span>Ray steps</span><output id="steps-value">160</output></span>
          <input id="ray-steps" type="range" min="64" max="320" step="16" value="160" />
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
    element<HTMLButtonElement>('toggle-run').addEventListener('click', () => this.setRunning(!this.running));
    element<HTMLButtonElement>('step').addEventListener('click', () => {
      if (this.running) {
        this.setRunning(false);
      }
      this.automaton.step();
      this.syncVolumeMaterial();
    });
    element<HTMLButtonElement>('reset').addEventListener('click', () => {
      this.automaton.reset(1);
      this.syncVolumeMaterial();
    });
    element<HTMLButtonElement>('reseed').addEventListener('click', () => {
      this.automaton.reset();
      this.syncVolumeMaterial();
    });
    element<HTMLButtonElement>('clear').addEventListener('click', () => {
      this.automaton.clear();
      this.syncVolumeMaterial();
    });

    element<HTMLSelectElement>('preset').addEventListener('change', (event) => {
      const id = (event.currentTarget as HTMLSelectElement).value;
      if (id !== 'custom') {
        this.loadPreset(getPreset(id));
        this.applyRuleFromPanel();
      }
    });

    element<HTMLSelectElement>('bounds').addEventListener('change', (event) => {
      this.bounds = Number((event.currentTarget as HTMLSelectElement).value);
      this.seedRadius = Math.min(this.seedRadius, Math.floor(this.bounds / 2));
      const radius = element<HTMLInputElement>('seed-radius');
      radius.max = String(Math.floor(this.bounds / 2));
      radius.value = String(this.seedRadius);
      element<HTMLOutputElement>('radius-value').value = String(this.seedRadius);
      this.rebuildAutomaton();
    });

    element<HTMLInputElement>('tick-rate').addEventListener('change', (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      this.tickRate = Number.isFinite(value) ? THREE.MathUtils.clamp(Math.round(value), 1, 60) : 10;
      (event.currentTarget as HTMLInputElement).value = String(this.tickRate);
      this.accumulator = 0;
    });

    const density = element<HTMLInputElement>('seed-density');
    density.addEventListener('input', () => {
      this.seedDensity = Number(density.value);
      element<HTMLOutputElement>('density-value').value = `${Math.round(this.seedDensity * 100)}%`;
      this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    });
    density.addEventListener('change', () => {
      this.automaton.reset();
      this.syncVolumeMaterial();
    });

    const radius = element<HTMLInputElement>('seed-radius');
    radius.addEventListener('input', () => {
      this.seedRadius = Number(radius.value);
      element<HTMLOutputElement>('radius-value').value = String(this.seedRadius);
      this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    });
    radius.addEventListener('change', () => {
      this.automaton.reset();
      this.syncVolumeMaterial();
    });

    for (const id of ['survival', 'birth', 'states']) {
      element<HTMLInputElement>(id).addEventListener('change', () => {
        element<HTMLSelectElement>('preset').value = 'custom';
        this.applyRuleFromPanel();
      });
    }

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-neighborhood]')) {
      button.addEventListener('click', () => {
        for (const sibling of this.panel.querySelectorAll('[data-neighborhood]')) {
          sibling.classList.toggle('selected', sibling === button);
          sibling.setAttribute('aria-pressed', String(sibling === button));
        }
        element<HTMLSelectElement>('preset').value = 'custom';
        this.applyRuleFromPanel();
      });
    }

    const updateColors = (): void => {
      this.volumeStyle.setColors(
        element<HTMLInputElement>('color-low').value,
        element<HTMLInputElement>('color-high').value,
      );
    };
    element<HTMLInputElement>('color-low').addEventListener('input', updateColors);
    element<HTMLInputElement>('color-high').addEventListener('input', updateColors);

    const steps = element<HTMLInputElement>('ray-steps');
    steps.addEventListener('input', () => {
      this.volumeStyle.steps.value = Number(steps.value);
      element<HTMLOutputElement>('steps-value').value = steps.value;
    });

    element<HTMLSelectElement>('render-scale').addEventListener('change', (event) => {
      this.renderScale = Number((event.currentTarget as HTMLSelectElement).value);
      this.resize();
    });
    element<HTMLInputElement>('auto-orbit').addEventListener('change', (event) => {
      this.orbit.autoRotate = (event.currentTarget as HTMLInputElement).checked;
    });
  }

  private loadPreset(preset: RulePreset): void {
    element<HTMLInputElement>('survival').value = preset.survival.join(', ');
    element<HTMLInputElement>('birth').value = preset.birth.join(', ');
    element<HTMLInputElement>('states').value = String(preset.states);
    element<HTMLInputElement>('color-low').value = preset.colorLow;
    element<HTMLInputElement>('color-high').value = preset.colorHigh;
    this.volumeStyle.setColors(preset.colorLow, preset.colorHigh);

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-neighborhood]')) {
      const selected = button.dataset.neighborhood === preset.neighborhood;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    this.rule = preset;
    this.updateRuleCode(preset.survival, preset.birth, preset.states);
  }

  private applyRuleFromPanel(): void {
    const survivalInput = element<HTMLInputElement>('survival');
    const birthInput = element<HTMLInputElement>('birth');
    const statesInput = element<HTMLInputElement>('states');
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
    this.syncVolumeMaterial();
    this.updateRuleCode(survival, birth, states);
    this.setStatus('WebGPU resident', 'ready');
  }

  private updateRuleCode(survival: readonly number[], birth: readonly number[], states: number): void {
    const compact = (counts: readonly number[]): string => counts.join('');
    element<HTMLElement>('rule-code').textContent = `S${compact(survival)} / B${compact(birth)} / ${states}`;
  }

  private rebuildAutomaton(): void {
    this.disposeVolumeMaterials();
    this.automaton.configureSeed(this.seedDensity, this.seedRadius);
    this.automaton.rebuild(this.bounds, this.rule);
    this.rebuildVolumeMaterials();
    this.accumulator = 0;
  }

  private rebuildVolumeMaterials(): void {
    const snapshot = this.automaton.snapshot();
    this.volumeStyle.setBounds(snapshot.bounds);

    const [firstTexture, secondTexture] = this.automaton.textures;

    this.volumeMaterials = [
      createVolumeMaterial(firstTexture, this.volumeStyle),
      createVolumeMaterial(secondTexture, this.volumeStyle),
    ];
    this.syncVolumeMaterial();
  }

  private syncVolumeMaterial(): void {
    if (this.volumeMaterials === null) {
      return;
    }
    this.volumeMesh.material = this.volumeMaterials[this.automaton.snapshot().textureIndex];
  }

  private disposeVolumeMaterials(): void {
    if (this.volumeMaterials === null) {
      return;
    }
    for (const material of this.volumeMaterials) {
      material.dispose();
    }
    this.volumeMaterials = null;
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.accumulator = 0;
    const toggle = element<HTMLButtonElement>('toggle-run');
    toggle.title = running ? 'Pause' : 'Play';
    toggle.ariaLabel = running ? 'Pause' : 'Play';
    toggle.innerHTML = `<i data-lucide="${running ? 'pause' : 'play'}"></i>`;
    element<HTMLElement>('run-state').textContent = running ? 'running' : 'paused';
    this.refreshIcons(toggle);
  }

  private animate(time: number): void {
    const delta = Math.min((time - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = time;

    if (this.running) {
      this.accumulator += delta;
      const tickDuration = 1 / this.tickRate;
      let catchUpSteps = 0;

      while (this.accumulator >= tickDuration && catchUpSteps < 4) {
        this.automaton.step();
        this.accumulator -= tickDuration;
        catchUpSteps += 1;
      }

      if (catchUpSteps === 4) {
        this.accumulator = Math.min(this.accumulator, tickDuration);
      }
    }

    this.syncVolumeMaterial();
    this.orbit.update(delta);
    this.renderer.render(this.scene, this.camera);
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

    this.fps = (this.frameCount * 1000) / (time - this.lastMetricsTime);
    this.frameCount = 0;
    this.lastMetricsTime = time;
    const snapshot = this.automaton.snapshot();

    element<HTMLElement>('metric-generation').textContent = formatInteger(snapshot.generation);
    element<HTMLElement>('metric-fps').textContent = this.fps.toFixed(0);
    element<HTMLElement>('metric-cells').textContent =
      snapshot.cellCount >= 1_000_000
        ? `${(snapshot.cellCount / 1_000_000).toFixed(1)}m`
        : `${Math.round(snapshot.cellCount / 1000)}k`;
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * this.renderScale, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.status.setAttribute('role', 'alert');
    this.setStatus(message, 'error');
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.orbit.dispose();
    this.disposeVolumeMaterials();
    this.automaton.dispose();
    this.volumeMesh.geometry.dispose();
    this.renderer.dispose();
  }
}

async function boot(): Promise<void> {
  const app = await CellularAutomataApp.create();
  app.start();
  window.addEventListener('pagehide', () => app.dispose(), { once: true });
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = element<HTMLElement>('status');
  element<HTMLElement>('status-text').textContent = message;
  status.dataset.state = 'error';
  status.setAttribute('role', 'alert');
  document.body.classList.add('fatal-error');
  console.error(error);
});

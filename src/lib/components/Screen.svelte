<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import createNESPlayerModule from '$lib/wasm/nes-player.js';
	import nesPlayerWasmUrl from '$lib/wasm/nes-player.wasm?url';

	interface NESModule {
		HEAPU8:                Uint8Array;
		_malloc:               (size: number) => number;
		_free:                 (ptr: number) => void;
		_init:                 () => void;
		_powerOn:              () => void;
		_powerOff:             () => void;
		_reset:                () => void;
		_pause:                () => void;
		_resume:               () => void;
		_isPaused:             () => number;
		_tickFrame:            (maxCycles: number) => number;
		_loadNESROM:           (ptr: number, size: number) => number;
		_getFramebufferPtr:    () => number;
		_getPPUFrame:          () => number;
		_setButtons:           (controller: number, mask: number) => void;
		_getSRAMPtr:           () => number;
		_getSRAMSize:          () => number;
		_hasBattery:           () => number;
		_getSRAMDirty:         () => number;
		_clearSRAMDirty:       () => void;
		_getFlashDirty:        () => number;
		_clearFlashDirty:      () => void;
		_getPRGRomPtr:         () => number;
		_getPRGRomSize:        () => number;
		_setAudioSampleRate:   (rate: number) => void;
		_getAudioBufferPtr:    () => number;
		_getAudioSampleCount:  () => number;
		_clearAudioSamples:    () => void;
		_getCPUHz:             () => number;
		_getCyclesPerFrame:    () => number;
		_getRegion:            () => number;
		_setRegion:            (region: number) => void;
	}

	interface Props {
		rom?:        Uint8Array;
		romName?:    string;
		volume?:     number;
		muted?:      boolean;
		sampleRate?: 48000 | 44100;
	}

	let {
		rom,
		romName,
		volume     = $bindable(1),
		muted      = $bindable(false),
		sampleRate = $bindable<48000 | 44100>(48000),
	}: Props = $props();

	const SCREEN_W  = 256;
	const SCREEN_H  = 240;
	const ASPECT    = (SCREEN_W * 8 / 7) / SCREEN_H;
	const RING_SIZE = 4096;

	const VERT_SRC = `
		attribute vec2 a_position;
		attribute vec2 a_texCoord;
		varying vec2 v_texCoord;
		void main() {
			gl_Position = vec4(a_position, 0.0, 1.0);
			v_texCoord = a_texCoord;
		}
	`;

	const FRAG_SRC = `
		precision mediump float;
		uniform sampler2D u_texture;
		varying vec2 v_texCoord;
		void main() {
			gl_FragColor = texture2D(u_texture, v_texCoord);
		}
	`;

	const KEY_MAP: Record<string, number> = {
		KeyX:       0x01,
		KeyZ:       0x02,
		ShiftRight: 0x04,
		Enter:      0x08,
		ArrowUp:    0x10,
		ArrowDown:  0x20,
		ArrowLeft:  0x40,
		ArrowRight: 0x80,
	};

	let container  = $state<HTMLDivElement | undefined>();
	let canvas     = $state<HTMLCanvasElement | undefined>();
	let fileInput  = $state<HTMLInputElement | undefined>();
	let overlayTop  = $state(0);
	let overlayH    = $state(0);
	let overlayLeft = $state(0);
	let overlayW    = $state(0);
	let nes        = $state<NESModule | null>(null);

	let currentRomName = '';
	let currentRomData: Uint8Array | null = null;
	let autoPaused     = false;

	let gl:         WebGLRenderingContext | null = null;
	let texture:    WebGLTexture | null         = null;
	let program:    WebGLProgram | null         = null;
	let posBuf:     WebGLBuffer | null          = null;
	let texBuf:     WebGLBuffer | null          = null;
	let animId:     number                      = 0;
	let lastTime:   number                      = 0;
	let cycleAccum: number                      = 0;

	let audioCtx:   AudioContext | null     = null;
	let gainNode:   GainNode | null         = null;
	let headerView: Int32Array | null       = null;
	let ringView:   Float32Array | null     = null;

	let held        = new SvelteSet<string>();
	let showOverlay = $state(false);
	let powered     = $state(false);
	let paused      = $state(false);

	function onContainerFocusIn() {
		if (!nes || !autoPaused) { return; }
		nes._resume();
		autoPaused = false;
	}

	function onContainerFocusOut(e: FocusEvent) {
		if (container?.contains(e.relatedTarget as Node)) { return; }
		if (!nes || paused || !powered) { return; }
		nes._pause();
		autoPaused = true;
	}

	function onContainerDblClick() {
		if (!nes || !powered) { return; }
		if (paused) {
			nes._resume();
			paused = false;
		} else {
			nes._pause();
			paused = true;
		}
	}

	function onContainerPointerDown() {
		container?.focus({ preventScroll: true });
	}

	function onContainerMouseMove(e: MouseEvent) {
		if (!container) {
			return;
		}
		const rect = container.getBoundingClientRect();
		showOverlay = rect.right - e.clientX <= 52;
	}

	function onContainerMouseLeave() {
		showOverlay = false;
	}

	function pollButtons(): number {
		let mask = 0;
		for (const [code, bit] of Object.entries(KEY_MAP)) {
			if (held.has(code)) {
				mask |= bit;
			}
		}
		const pad = navigator.getGamepads()[0];
		if (pad) {
			if (pad.buttons[0]?.pressed) {
				mask |= 0x01;
			}
			if (pad.buttons[1]?.pressed) {
				mask |= 0x02;
			}
			if (pad.buttons[8]?.pressed) {
				mask |= 0x04;
			}
			if (pad.buttons[9]?.pressed) {
				mask |= 0x08;
			}
			if (pad.buttons[12]?.pressed) {
				mask |= 0x10;
			}
			if (pad.buttons[13]?.pressed) {
				mask |= 0x20;
			}
			if (pad.buttons[14]?.pressed) {
				mask |= 0x40;
			}
			if (pad.buttons[15]?.pressed) {
				mask |= 0x80;
			}
			if (pad.axes[0] < -0.5) {
				mask |= 0x40;
			}
			if (pad.axes[0] > 0.5) {
				mask |= 0x80;
			}
			if (pad.axes[1] < -0.5) {
				mask |= 0x10;
			}
			if (pad.axes[1] > 0.5) {
				mask |= 0x20;
			}
		}
		return mask;
	}

	function pushSamples(samples: Float32Array) {
		if (!headerView || !ringView) {
			return;
		}
		const writePos  = Atomics.load(headerView, 0);
		const readPos   = Atomics.load(headerView, 1);
		const available = RING_SIZE - ((writePos - readPos + RING_SIZE) % RING_SIZE) - 1;
		const count     = Math.min(samples.length, available);
		for (let i = 0; i < count; i++) {
			ringView[(writePos + i) % RING_SIZE] = samples[i];
		}
		Atomics.store(headerView, 0, (writePos + count) % RING_SIZE);
	}

	function getAudioSamples(module: NESModule): Float32Array {
		const count = module._getAudioSampleCount();
		if (count === 0) {
			return new Float32Array(0);
		}
		const ptr     = module._getAudioBufferPtr();
		const samples = new Float32Array(module.HEAPU8.buffer, ptr, count);
		const copy    = new Float32Array(count);
		copy.set(samples);
		module._clearAudioSamples();
		return copy;
	}

	function restoreSaves(module: NESModule) {
		const sramSave = localStorage.getItem(`nesplayer-${currentRomName}.sram`);
		if (sramSave && module._hasBattery()) {
			const bytes = Uint8Array.from(atob(sramSave), c => c.charCodeAt(0));
			module.HEAPU8.set(bytes, module._getSRAMPtr());
		}
		const flashSave = localStorage.getItem(`nesplayer-${currentRomName}.flash`);
		if (flashSave) {
			const bytes = Uint8Array.from(atob(flashSave), c => c.charCodeAt(0));
			const ptr   = module._getPRGRomPtr();
			if (ptr && bytes.length <= module._getPRGRomSize()) {
				module.HEAPU8.set(bytes, ptr);
			}
		}
	}

	function flushSRAM(module: NESModule) {
		if (!module._hasBattery() || !module._getSRAMDirty()) {
			return;
		}
		const ptr  = module._getSRAMPtr();
		const size = module._getSRAMSize();
		const data = module.HEAPU8.slice(ptr, ptr + size);
		localStorage.setItem(`nesplayer-${currentRomName}.sram`, btoa(String.fromCharCode(...data)));
		module._clearSRAMDirty();
	}

	function flushFlash(module: NESModule) {
		if (!module._getFlashDirty()) {
			return;
		}
		const ptr  = module._getPRGRomPtr();
		const size = module._getPRGRomSize();
		const data = module.HEAPU8.slice(ptr, ptr + size);
		localStorage.setItem(`nesplayer-${currentRomName}.flash`, btoa(String.fromCharCode(...data)));
		module._clearFlashDirty();
	}

	function loadROM(module: NESModule, data: Uint8Array) {
		const ptr    = module._malloc(data.length);
		module.HEAPU8.set(data, ptr);
		const result = module._loadNESROM(ptr, data.length);
		module._free(ptr);
		if (result !== 0) {
			throw new Error(`loadNESROM failed (${result})`);
		}
		restoreSaves(module);
	}

	function createShader(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
		const shader = g.createShader(type);
		if (!shader) {
			return null;
		}
		g.shaderSource(shader, src);
		g.compileShader(shader);
		if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) {
			console.error('[NESScreen] Shader error:', g.getShaderInfoLog(shader));
			g.deleteShader(shader);
			return null;
		}
		return shader;
	}

	function initWebGL(c: HTMLCanvasElement): boolean {
		gl = c.getContext('webgl', { alpha: false, antialias: false });
		if (!gl) {
			return false;
		}

		const vs = createShader(gl, gl.VERTEX_SHADER,   VERT_SRC);
		const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
		if (!vs || !fs) {
			return false;
		}

		const prog = gl.createProgram();
		if (!prog) {
			return false;
		}
		gl.attachShader(prog, vs);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			console.error('[NESScreen] Program link error:', gl.getProgramInfoLog(prog));
			return false;
		}
		program = prog;

		posBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

		texBuf = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1, 1,1, 0,0, 1,0]), gl.STATIC_DRAW);

		texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

		return true;
	}

	async function initAudio(module: NESModule) {
		if (typeof SharedArrayBuffer === 'undefined') {
			console.warn('[NESScreen] SharedArrayBuffer unavailable — audio disabled. Serve with COOP/COEP headers to enable.');
			return;
		}
		if (!audioCtx) {
			audioCtx = new AudioContext({ sampleRate });
		}
		console.log('[NESScreen] AudioContext state:', audioCtx.state, 'sampleRate:', audioCtx.sampleRate);
		void audioCtx.resume();

		await audioCtx.audioWorklet.addModule('/audio-worklet.js');

		const workletNode = new AudioWorkletNode(audioCtx, 'nes-audio-processor', {
			numberOfInputs:     0,
			numberOfOutputs:    1,
			outputChannelCount: [2],
		});
		gainNode = audioCtx.createGain();
		gainNode.gain.value = muted ? 0 : volume;
		workletNode.connect(gainNode);
		gainNode.connect(audioCtx.destination);

		const sab  = new SharedArrayBuffer(8 + RING_SIZE * 4);
		headerView = new Int32Array(sab, 0, 2);
		ringView   = new Float32Array(sab, 8, RING_SIZE);
		workletNode.port.postMessage({ type: 'init', sharedBuffer: sab });

		module._setAudioSampleRate(sampleRate);
		console.log('[NESScreen] Audio init complete. sampleCount after rate set:', module._getAudioSampleCount());
	}

	function fitCanvas() {
		if (!container || !canvas) {
			return;
		}
		const cw = container.clientWidth;
		const ch = container.clientHeight;
		const ar = cw / ch;
		let w: number, h: number;
		if (ar > ASPECT) {
			h = ch;
			w = Math.round(ch * ASPECT);
		} else {
			w = cw;
			h = Math.round(cw / ASPECT);
		}
		canvas.style.width  = `${w}px`;
		canvas.style.height = `${h}px`;
		const dpr = window.devicePixelRatio || 1;
		canvas.width  = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		overlayTop  = Math.round((ch - h) / 2);
		overlayH    = h;
		overlayLeft = Math.round((cw - w) / 2);
		overlayW    = w;
	}

	function drawFrame(module: NESModule) {
		if (!gl || !texture || !program || !posBuf || !texBuf) {
			return;
		}
		const ptr      = module._getFramebufferPtr();
		const framebuf = module.HEAPU8.subarray(ptr, ptr + SCREEN_W * SCREEN_H * 4);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SCREEN_W, SCREEN_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, framebuf);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, canvas!.width, canvas!.height);
		gl.useProgram(program);

		const posLoc = gl.getAttribLocation(program, 'a_position');
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

		const texLoc = gl.getAttribLocation(program, 'a_texCoord');
		gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
		gl.enableVertexAttribArray(texLoc);
		gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function runFrame(currentTime: number) {
		animId = requestAnimationFrame(runFrame);

		const module = nes;
		if (!module) {
			return;
		}

		module._setButtons(0, pollButtons());

		if (module._isPaused()) {
			lastTime   = 0;
			cycleAccum = 0;
			return;
		}

		if (lastTime === 0) {
			lastTime = currentTime;
		}
		const elapsed = (currentTime - lastTime) / 1000;
		lastTime = currentTime;
		cycleAccum += Math.min(elapsed, 1 / 15) * module._getCPUHz();

		const cpf = module._getCyclesPerFrame();
		if (cycleAccum < cpf) {
			return;
		}

		let framesRun = 0;
		while (cycleAccum >= cpf && framesRun < 4) {
			const executed = module._tickFrame(cpf);
			cycleAccum -= executed;
			framesRun++;
			if (headerView) {
				const samples = getAudioSamples(module);
				if (samples.length > 0) {
					pushSamples(samples);
				}
			} else {
				module._clearAudioSamples();
			}
		}

		if (module._getSRAMDirty()) {
			flushSRAM(module);
		}
		if (module._getFlashDirty()) {
			flushFlash(module);
		}

		drawFrame(module);
	}

	$effect(() => {
		if (!nes || !rom) {
			return;
		}
		currentRomName = romName ?? '';
		currentRomData = rom;
		lastTime       = 0;
		cycleAccum     = 0;
		powered        = true;
		loadROM(nes, rom);
	});

	$effect(() => {
		const gain = muted ? 0 : volume;
		if (!gainNode) {
			return;
		}
		gainNode.gain.value = gain;
	});

	$effect(() => {
		if (!nes || !audioCtx || audioCtx.sampleRate === sampleRate) {
			return;
		}
		headerView = null;
		ringView   = null;
		gainNode   = null;
		const old = audioCtx;
		audioCtx  = null;
		void (async () => {
			await old.close();
			await initAudio(nes!);
		})();
	});

	function clearScreen() {
		if (!gl) {
			return;
		}
		gl.clearColor(0, 0, 0, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
	}

	function onPower() {
		if (!nes) {
			return;
		}
		if (powered) {
			flushSRAM(nes);
			flushFlash(nes);
			nes._powerOff();
			nes._pause();
			nes._clearAudioSamples();
			lastTime   = 0;
			cycleAccum = 0;
			clearScreen();
			powered = false;
			paused  = false;
		} else {
			nes._powerOn();
			nes._resume();
			lastTime   = 0;
			cycleAccum = 0;
			if (currentRomData) {
				loadROM(nes, currentRomData);
			}
			powered = true;
		}
	}

	function onPauseToggle() {
		if (!nes) {
			return;
		}
		if (paused) {
			nes._resume();
			paused = false;
		} else {
			nes._pause();
			paused = true;
		}
	}

	function onReset() {
		if (!nes) {
			return;
		}
		nes._reset();
		nes._resume();
		lastTime   = 0;
		cycleAccum = 0;
		paused     = false;
	}

	function onVolumeInput(e: Event) {
		const val = parseFloat((e.target as HTMLInputElement).value);
		volume = val;
		if (val > 0) {
			muted = false;
		}
	}

	function onMuteToggle() {
		muted = !muted;
	}

	function onInsertRomClick() {
		fileInput?.click();
	}

	async function onFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file || !nes) {
			return;
		}

		// Flush saves for the current ROM before evicting it
		flushSRAM(nes);
		flushFlash(nes);

		// Reset clears CPU, PPU, APU and mapper state without evicting the ROM slot
		nes._reset();

		// Reset animation timing so the first frame isn't a huge jump
		lastTime   = 0;
		cycleAccum = 0;

		// Clear audio sample buffer left over from the previous ROM
		nes._clearAudioSamples();

		// Set the new ROM name before loading so restoreSaves uses the right key
		currentRomName = file.name.replace(/\.nes$/i, '');

		const data     = new Uint8Array(await file.arrayBuffer());
		currentRomData = data;
		powered        = true;
		loadROM(nes, data);

		// Reset the file input so the same file can be re-inserted
		(e.target as HTMLInputElement).value = '';
	}

	onMount(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') {
				return;
			}
			held.add(e.code);
			if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
				e.preventDefault();
			}
		};
		const onKeyUp = (e: KeyboardEvent) => {
			held.delete(e.code);
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup',   onKeyUp);

		const ro = new ResizeObserver(() => fitCanvas());
		if (container) {
			ro.observe(container);
		}

		const onUnload = () => {
			if (nes) {
				flushSRAM(nes);
				flushFlash(nes);
			}
		};
		window.addEventListener('beforeunload', onUnload);

		if (typeof SharedArrayBuffer !== 'undefined') {
			audioCtx = new AudioContext({ sampleRate });
			void audioCtx.resume();
		}

		const resumeCtx = () => {
			if (audioCtx?.state === 'suspended') {
				void audioCtx.resume();
			}
		};
		document.addEventListener('click',       resumeCtx);
		document.addEventListener('keydown',     resumeCtx);
		document.addEventListener('pointerdown', resumeCtx);

		void (async () => {
			const module  = await createNESPlayerModule({
				locateFile: (f: string) => f.endsWith('.wasm') ? nesPlayerWasmUrl : f,
			}) as NESModule;
			module._init();
			module._powerOn();
			await initAudio(module);
			nes = module;
			if (canvas && initWebGL(canvas)) {
				fitCanvas();
				animId = requestAnimationFrame(runFrame);
			}
		})();

		return () => {
			cancelAnimationFrame(animId);
			if (nes) {
				flushSRAM(nes);
				flushFlash(nes);
				nes._powerOff();
			}
			void audioCtx?.close();
			ro.disconnect();
			window.removeEventListener('keydown',      onKeyDown);
			window.removeEventListener('keyup',        onKeyUp);
			window.removeEventListener('beforeunload', onUnload);
			held.clear();
			document.removeEventListener('click',       resumeCtx);
			document.removeEventListener('keydown',     resumeCtx);
			document.removeEventListener('pointerdown', resumeCtx);
		};
	});
</script>

<div
	bind:this={container}
	class="nes-screen"
	role="application"
	aria-label="NES emulator"
	tabindex="-1"
	onpointerdown={onContainerPointerDown}
	ondblclick={onContainerDblClick}
	onmousemove={onContainerMouseMove}
	onmouseleave={onContainerMouseLeave}
	onfocusin={onContainerFocusIn}
	onfocusout={onContainerFocusOut}
>
	<canvas bind:this={canvas}></canvas>

	{#if paused && powered}
		<div
			class="pause-overlay"
			style="top: {overlayTop}px; left: {overlayLeft}px; width: {overlayW}px; height: {overlayH}px;"
		>
			Paused
		</div>
	{/if}

	<div class="overlay-zone" class:visible={showOverlay} style="top: {overlayTop}px; height: {overlayH}px;">
		<div
			class="overlay-panel"
			role="toolbar"
			aria-label="Emulator controls"
			onclick={(e) => e.stopPropagation()}
			ondblclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
		>

			<button class="overlay-btn" class:powered title={powered ? 'Power off' : 'Power on'} onclick={onPower}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2v6"/>
					<path d="M6.4 5.4a8 8 0 1 0 11.2 0"/>
				</svg>
			</button>

			<button class="overlay-btn" class:active={paused} title={paused ? 'Resume' : 'Pause'} onclick={onPauseToggle}>
				{#if paused}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="5 3 19 12 5 21 5 3"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="6" y="4" width="4" height="16"/>
						<rect x="14" y="4" width="4" height="16"/>
					</svg>
				{/if}
			</button>

			<button class="overlay-btn" title="Reset" onclick={onReset}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
					<path d="M3 3v5h5"/>
				</svg>
			</button>

			<div class="slider-wrap">
				<input
					type="range"
					class="vol-slider"
					min="0" max="1" step="0.01"
					value={muted ? 0 : volume}
					oninput={onVolumeInput}
				/>
			</div>

			<button class="overlay-btn" class:active={muted} title={muted ? 'Unmute' : 'Mute'} onclick={onMuteToggle}>
				{#if muted}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
						<line x1="23" y1="9" x2="17" y2="15"/>
						<line x1="17" y1="9" x2="23" y2="15"/>
					</svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
						<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
					</svg>
				{/if}
			</button>

			<button class="overlay-btn" title="Insert ROM" onclick={onInsertRomClick}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M4 2h16a2 2 0 0 1 2 2v10h-5v6h-10v-6H2V4a2 2 0 0 1 2-2z"/>
					<rect x="5" y="5" width="14" height="6" rx="1"/>
				</svg>
			</button>
			<input bind:this={fileInput} type="file" accept=".nes" style="display:none" onchange={onFileChange} />

			<button class="overlay-btn" title="Controllers">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="6" y1="12" x2="10" y2="12"/>
					<line x1="8" y1="10" x2="8" y2="14"/>
					<circle cx="15" cy="13" r="0.5" fill="currentColor"/>
					<circle cx="18" cy="11" r="0.5" fill="currentColor"/>
					<rect x="2" y="6" width="20" height="12" rx="2"/>
				</svg>
			</button>

			<button class="overlay-btn" title="Settings">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
				</svg>
			</button>

		</div>
	</div>
</div>

<style>
	.nes-screen {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: black;
		position: relative;
		outline: none;
	}

	.pause-overlay {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.45);
		color: rgba(255, 255, 255, 0.9);
		font-size: 1.5rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		pointer-events: none;
	}

	.overlay-zone {
		position: absolute;
		right: 0;
		width: 52px;
		overflow: hidden;
		pointer-events: none;
	}

	.overlay-zone.visible {
		pointer-events: auto;
	}

	.overlay-panel {
		position: absolute;
		inset: 0;
		box-sizing: border-box;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 6px 0;
		gap: 4px;
		overflow: hidden;
		opacity: 0;
		transition: opacity 0.15s ease;
	}

	.overlay-zone.visible .overlay-panel {
		opacity: 1;
	}

	.overlay-btn {
		width: 36px;
		height: 36px;
		min-height: 0;
		border: none;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.1);
		color: rgba(255, 255, 255, 0.85);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.overlay-btn:hover {
		background: rgba(255, 255, 255, 0.25);
	}

	.overlay-btn.active {
		color: #f87171;
	}

	.overlay-btn.powered {
		color: #4ade80;
	}

	.slider-wrap {
		flex: 1;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		min-height: 0;
	}

	.vol-slider {
		writing-mode: vertical-lr;
		direction: rtl;
		width: 32px;
		height: 100%;
		cursor: pointer;
		accent-color: rgba(255, 255, 255, 0.85);
	}
</style>

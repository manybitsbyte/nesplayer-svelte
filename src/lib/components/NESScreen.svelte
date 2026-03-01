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
		rom:        Uint8Array;
		romName:    string;
		volume?:    number;
		muted?:     boolean;
		sampleRate?: 48000 | 44100;
	}

	let { rom, romName, volume = 1, muted = false, sampleRate = 48000 }: Props = $props();

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

	let container = $state<HTMLDivElement | undefined>();
	let canvas    = $state<HTMLCanvasElement | undefined>();
	let nes       = $state<NESModule | null>(null);

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

	let held = new SvelteSet<string>();

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
		const sramSave = localStorage.getItem(`nesplayer-${romName}.sram`);
		if (sramSave && module._hasBattery()) {
			const bytes = Uint8Array.from(atob(sramSave), c => c.charCodeAt(0));
			module.HEAPU8.set(bytes, module._getSRAMPtr());
		}
		const flashSave = localStorage.getItem(`nesplayer-${romName}.flash`);
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
		localStorage.setItem(`nesplayer-${romName}.sram`, btoa(String.fromCharCode(...data)));
		module._clearSRAMDirty();
	}

	function flushFlash(module: NESModule) {
		if (!module._getFlashDirty()) {
			return;
		}
		const ptr  = module._getPRGRomPtr();
		const size = module._getPRGRomSize();
		const data = module.HEAPU8.slice(ptr, ptr + size);
		localStorage.setItem(`nesplayer-${romName}.flash`, btoa(String.fromCharCode(...data)));
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
		const dpr     = window.devicePixelRatio || 1;
		canvas.width  = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
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
		lastTime   = 0;
		cycleAccum = 0;
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

<div bind:this={container} class="nes-screen">
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	.nes-screen {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: black;
	}
</style>

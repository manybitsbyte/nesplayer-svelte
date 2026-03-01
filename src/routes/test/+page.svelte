<script lang="ts">
	import { onMount } from 'svelte';
	import NESScreen from '$lib/components/NESScreen.svelte';
	import Volume from '$lib/components/Volume.svelte';

	const NES_ASPECT = (256 * 8 / 7) / 240;
	const MIN_SIZE   = 80;

	let rom        = $state<Uint8Array | null>(null);
	let romName    = $state('');
	let volume     = $state(1);
	let muted      = $state(false);
	let sampleRate = $state<48000 | 44100>(48000);
	let boxW       = $state(0);
	let boxH       = $state(0);

	let dragging = false;
	let startX   = 0;
	let startY   = 0;
	let startW   = 0;
	let startH   = 0;

	onMount(() => {
		boxW = window.innerWidth * 0.35;
		boxH = boxW / NES_ASPECT;
	});

	async function onFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) {
			return;
		}
		const buf = await file.arrayBuffer();
		rom     = new Uint8Array(buf);
		romName = file.name.replace(/\.nes$/i, '');
	}

	function onHandleDown(e: PointerEvent) {
		dragging = true;
		startX   = e.clientX;
		startY   = e.clientY;
		startW   = boxW;
		startH   = boxH;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onHandleMove(e: PointerEvent) {
		if (!dragging) {
			return;
		}
		boxW = Math.max(MIN_SIZE, startW + (e.clientX - startX));
		boxH = Math.max(MIN_SIZE, startH + (e.clientY - startY));
	}

	function onHandleUp() {
		dragging = false;
	}
</script>

<div class="test-page">
	<div class="screen-wrapper" style="width: {boxW}px; height: {boxH}px;">
		{#if rom}
			<NESScreen {rom} {romName} {volume} {muted} {sampleRate} />
		{:else}
			<label class="rom-picker">
				<span>Load a .nes ROM to test</span>
				<input type="file" accept=".nes" onchange={onFileChange} />
			</label>
		{/if}
		<div
			class="resize-handle"
			role="presentation"
			onpointerdown={onHandleDown}
			onpointermove={onHandleMove}
			onpointerup={onHandleUp}
		></div>
	</div>

	<div class="controls-box">
		<Volume bind:volume bind:muted bind:sampleRate />
	</div>
</div>

<style>
	.test-page {
		width: 100vw;
		height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.screen-wrapper {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		outline: 1px solid black;
	}

	.resize-handle {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 16px;
		height: 16px;
		cursor: nwse-resize;
		background: rgba(255, 255, 255, 0.25);
	}

	.rom-picker {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		color: #ccc;
		cursor: pointer;
	}

	.rom-picker input {
		display: none;
	}

	.controls-box {
		position: fixed;
		bottom: 1.5rem;
		right: 1.5rem;
		outline: 1px solid black;
		padding: 0.75rem;
	}
</style>

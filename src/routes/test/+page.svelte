<script lang="ts">
	import { onMount } from 'svelte';
	import Screen from '$lib/components/Screen.svelte';

	const NES_ASPECT = (256 * 8 / 7) / 240;
	const MIN_SIZE   = 80;

	let boxW = $state(0);
	let boxH = $state(0);

	let dragging = false;
	let startX   = 0;
	let startY   = 0;
	let startW   = 0;
	let startH   = 0;

	onMount(() => {
		boxW = window.innerWidth * 0.35;
		boxH = boxW / NES_ASPECT;
	});

	function onHandleDown(e: PointerEvent) {
		dragging = true;
		startX   = e.clientX;
		startY   = e.clientY;
		startW   = boxW;
		startH   = boxH;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onHandleMove(e: PointerEvent) {
		if (!dragging) { return; }
		boxW = Math.max(MIN_SIZE, startW + (e.clientX - startX));
		boxH = Math.max(MIN_SIZE, startH + (e.clientY - startY));
	}

	function onHandleUp() {
		dragging = false;
	}
</script>

<div class="test-page">
	<div class="screen-wrapper" style="width: {boxW}px; height: {boxH}px;">
		<Screen />
		<div
			class="resize-handle"
			role="presentation"
			onpointerdown={onHandleDown}
			onpointermove={onHandleMove}
			onpointerup={onHandleUp}
		></div>
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
</style>

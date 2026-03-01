<script lang="ts">
	interface Props {
		orientation?: 'vertical' | 'horizontal';
		volume?:      number;
		muted?:       boolean;
		sampleRate?:  48000 | 44100;
	}

	let {
		orientation = 'vertical',
		volume      = $bindable(1),
		muted       = $bindable(false),
		sampleRate  = $bindable<48000 | 44100>(48000),
	}: Props = $props();

	function toggleMute() {
		muted = !muted;
	}

	function toggleRate() {
		sampleRate = sampleRate === 48000 ? 44100 : 48000;
	}

	function onSliderInput(e: Event) {
		volume = parseFloat((e.target as HTMLInputElement).value);
		if (volume > 0) {
			muted = false;
		}
	}
</script>

<div class="volume-control" class:horizontal={orientation === 'horizontal'}>
	<button class="btn" class:dimmed={muted} onclick={toggleMute}>
		{muted ? 'Unmute' : 'Mute'}
	</button>

	<input
		class="slider"
		class:vertical={orientation === 'vertical'}
		type="range"
		min="0"
		max="1"
		step="0.01"
		value={volume}
		oninput={onSliderInput}
	/>

	<button class="btn" onclick={toggleRate}>
		{sampleRate === 48000 ? '48k' : '44.1k'}
	</button>
</div>

<style>
	.volume-control {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		user-select: none;
	}

	.volume-control.horizontal {
		flex-direction: row;
	}

	.slider {
		width: 120px;
	}

	.slider.vertical {
		writing-mode: vertical-lr;
		direction: rtl;
		width: auto;
		height: 120px;
	}

	.btn {
		background: transparent;
		border: 1px solid currentColor;
		color: inherit;
		cursor: pointer;
		padding: 0.2rem 0.4rem;
		font-size: 0.7rem;
		font-family: inherit;
	}

	.btn.dimmed {
		opacity: 0.4;
	}
</style>

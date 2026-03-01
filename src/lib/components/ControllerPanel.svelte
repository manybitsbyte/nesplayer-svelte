<script lang="ts">
	type GamepadInfo    = { id: string; index: number; name: string };
	type GamepadProfile = { id: string; buttonMap: Record<number, number>; quickSaveBtn?: number | null; quickLoadBtn?: number | null };
	type PlayerInput    = { type: 'keyboard' } | { type: 'gamepad'; id: string } | { type: 'none' };

	const NES_BUTTONS: Array<{ label: string; bit: number }> = [
		{ label: 'Up',     bit: 0x10 },
		{ label: 'Down',   bit: 0x20 },
		{ label: 'Left',   bit: 0x40 },
		{ label: 'Right',  bit: 0x80 },
		{ label: 'Select', bit: 0x04 },
		{ label: 'Start',  bit: 0x08 },
		{ label: 'B',      bit: 0x02 },
		{ label: 'A',      bit: 0x01 },
	];

	const GP_BTN_NAMES: Record<number, string> = {
		0: 'A', 1: 'B', 2: 'X', 3: 'Y',
		4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
		8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3',
		12: '↑', 13: '↓', 14: '←', 15: '→',
	};

	function keyLabel(code: string): string {
		const named: Record<string, string> = {
			ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
			ShiftLeft: 'L.Shift', ShiftRight: 'R.Shift',
			ControlLeft: 'L.Ctrl', ControlRight: 'R.Ctrl',
			AltLeft: 'L.Alt', AltRight: 'R.Alt',
			Enter: 'Enter', Space: 'Space', Escape: 'Esc',
			Tab: 'Tab', Backspace: '⌫', Delete: 'Del',
			CapsLock: 'Caps', MetaLeft: 'L.Meta', MetaRight: 'R.Meta',
		};
		if (named[code]) { return named[code]; }
		if (code.startsWith('Key'))    { return code.slice(3); }
		if (code.startsWith('Digit'))  { return code.slice(5); }
		if (code.startsWith('Numpad')) { return 'Num' + code.slice(6); }
		return code;
	}

	function gpBtnLabel(idx: number): string {
		return GP_BTN_NAMES[idx] ?? `Btn ${idx}`;
	}

	function keyForBit(map: Record<string, number>, bit: number): string {
		for (const [code, b] of Object.entries(map)) {
			if (b === bit) { return code; }
		}
		return '';
	}

	function gpIdxForBit(map: Record<number, number>, bit: number): number | null {
		for (const [idx, b] of Object.entries(map)) {
			if (b === bit) { return Number(idx); }
		}
		return null;
	}

	interface Props {
		defaultKeyMap:           Record<string, number>;
		defaultGamepadButtonMap: Record<number, number>;
		detectedGamepads:        GamepadInfo[];
		gamepadProfiles:         GamepadProfile[];
		player1Input:            PlayerInput;
		player2Input:            PlayerInput;
		player1KeyMap:           Record<string, number>;
		player2KeyMap:           Record<string, number>;
		quickSaveKey:            string;
		quickLoadKey:            string;
		onquicksavekeychange:    (key: string) => void;
		onquickloadkeychange:    (key: string) => void;
		onplayer1inputchange:    (v: PlayerInput) => void;
		onplayer2inputchange:    (v: PlayerInput) => void;
		onplayer1keymapchange:   (m: Record<string, number>) => void;
		onplayer2keymapchange:   (m: Record<string, number>) => void;
		ongpprofilechange:       (p: GamepadProfile) => void;
		onclose:                 () => void;
	}

	let {
		defaultKeyMap, defaultGamepadButtonMap,
		detectedGamepads, gamepadProfiles,
		player1Input, player2Input,
		player1KeyMap, player2KeyMap,
		quickSaveKey, quickLoadKey,
		onquicksavekeychange, onquickloadkeychange,
		onplayer1inputchange, onplayer2inputchange,
		onplayer1keymapchange, onplayer2keymapchange,
		ongpprofilechange, onclose,
	}: Props = $props();

	let kbRebind       = $state<{ player: 1 | 2; bit: number } | null>(null);
	let gpRebind       = $state<{ padId: string; bit: number } | null>(null);
	let stateKeyRebind = $state<'save' | 'load' | null>(null);
	let stateGpRebind  = $state<{ padId: string; which: 'save' | 'load' } | null>(null);

	function activeProfile(padId: string): GamepadProfile {
		return gamepadProfiles.find(p => p.id === padId) ?? { id: padId, buttonMap: { ...defaultGamepadButtonMap } };
	}

	// Assign an input to a player. If a gamepad is being assigned, remove it from the other player first.
	function assignP1(input: PlayerInput) {
		if (input.type === 'gamepad' && player2Input.type === 'gamepad' && player2Input.id === input.id) {
			onplayer2inputchange({ type: 'none' });
		}
		onplayer1inputchange(input);
	}

	function assignP2(input: PlayerInput) {
		if (input.type === 'gamepad' && player1Input.type === 'gamepad' && player1Input.id === input.id) {
			onplayer1inputchange({ type: 'keyboard' });
		}
		onplayer2inputchange(input);
	}

	// Keyboard rebind effect
	$effect(() => {
		if (!kbRebind) { return; }
		const { player, bit } = kbRebind;
		const handler = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (e.code === 'Escape') { kbRebind = null; return; }
			const src  = player === 1 ? player1KeyMap : player2KeyMap;
			const emit = player === 1 ? onplayer1keymapchange : onplayer2keymapchange;
			const next: Record<string, number> = {};
			for (const [code, b] of Object.entries(src)) {
				if (b !== bit) { next[code] = b; }
			}
			next[e.code] = bit;
			emit(next);
			kbRebind = null;
		};
		window.addEventListener('keydown', handler, { capture: true });
		return () => { window.removeEventListener('keydown', handler, { capture: true }); };
	});

	$effect(() => {
		if (!stateKeyRebind) { return; }
		const which = stateKeyRebind;
		const handler = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (e.code === 'Escape') { stateKeyRebind = null; return; }
			if (which === 'save') { onquicksavekeychange(e.code); }
			else                  { onquickloadkeychange(e.code); }
			stateKeyRebind = null;
		};
		window.addEventListener('keydown', handler, { capture: true });
		return () => { window.removeEventListener('keydown', handler, { capture: true }); };
	});

	$effect(() => {
		if (!gpRebind) { return; }
		const { padId, bit } = gpRebind;

		const initialGp = [...navigator.getGamepads()].find(p => p?.id === padId && p?.connected);
		const initial   = new Set<number>();
		if (initialGp) {
			for (let i = 0; i < initialGp.buttons.length; i++) {
				if (initialGp.buttons[i]?.pressed) { initial.add(i); }
			}
		}
		let released = initial.size === 0;

		function poll() {
			const gp = [...navigator.getGamepads()].find(p => p?.id === padId && p?.connected) ?? null;
			if (!gp) { return; }

			if (!released) {
				released = ![...initial].some(i => gp.buttons[i]?.pressed);
				return;
			}

			for (let i = 0; i < gp.buttons.length; i++) {
				if (gp.buttons[i]?.pressed) {
					const curProfile = activeProfile(padId);
					const next: Record<number, number> = {};
					for (const [k, v] of Object.entries(curProfile.buttonMap)) {
						if (v !== bit) { next[Number(k)] = v; }
					}
					next[i] = bit;
					ongpprofilechange({ ...curProfile, buttonMap: next });
					gpRebind = null;
					return;
				}
			}
		}

		const intervalId = setInterval(poll, 16);
		return () => { clearInterval(intervalId); };
	});

	$effect(() => {
		if (!stateGpRebind) { return; }
		const { padId, which } = stateGpRebind;

		const initialGp = [...navigator.getGamepads()].find(p => p?.id === padId && p?.connected);
		const initial   = new Set<number>();
		if (initialGp) {
			for (let i = 0; i < initialGp.buttons.length; i++) {
				if (initialGp.buttons[i]?.pressed) { initial.add(i); }
			}
		}
		let released = initial.size === 0;

		function poll() {
			const gp = [...navigator.getGamepads()].find(p => p?.id === padId && p?.connected) ?? null;
			if (!gp) { return; }
			if (!released) {
				released = ![...initial].some(i => gp.buttons[i]?.pressed);
				return;
			}
			for (let i = 0; i < gp.buttons.length; i++) {
				if (gp.buttons[i]?.pressed) {
					const cur = activeProfile(padId);
					if (which === 'save') {
						ongpprofilechange({ ...cur, quickSaveBtn: i });
					} else {
						ongpprofilechange({ ...cur, quickLoadBtn: i });
					}
					stateGpRebind = null;
					return;
				}
			}
		}

		const intervalId = setInterval(poll, 16);
		return () => { clearInterval(intervalId); };
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="cp-backdrop" role="presentation" onclick={onclose}></div>

<div
	class="cp-panel"
	role="dialog"
	aria-label="Controller settings"
	aria-modal="true"
	onclick={(e) => e.stopPropagation()}
	ondblclick={(e) => e.stopPropagation()}
>
	<div class="cp-header">
		<span class="cp-title">Controllers</span>
		<button class="cp-close" onclick={onclose} title="Close" aria-label="Close">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
				<line x1="18" y1="6" x2="6" y2="18"/>
				<line x1="6" y1="6" x2="18" y2="18"/>
			</svg>
		</button>
	</div>

	<div class="cp-art">
		<svg viewBox="0 0 260 160" xmlns="http://www.w3.org/2000/svg" class="cp-svg" aria-hidden="true">
			<defs>
				<linearGradient id="cpWireGrad" gradientUnits="userSpaceOnUse" x1="0" y1="36" x2="0" y2="-10">
					<stop offset="0%" stop-color="#888" stop-opacity="1"/>
					<stop offset="100%" stop-color="#888" stop-opacity="0"/>
				</linearGradient>
				<linearGradient id="cpBodyGrad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="#2c2c2c"/>
					<stop offset="100%" stop-color="#191919"/>
				</linearGradient>
				<linearGradient id="cpDpadGrad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="#4a4a4a"/>
					<stop offset="100%" stop-color="#2e2e2e"/>
				</linearGradient>
				<radialGradient id="cpBtnRed" cx="38%" cy="32%" r="62%">
					<stop offset="0%" stop-color="#f04040"/>
					<stop offset="100%" stop-color="#8b0f0f"/>
				</radialGradient>
				<filter id="cpShadow">
					<feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-opacity="0.45"/>
				</filter>
			</defs>
			<path d="M124,36 C112,24 144,12 130,2 C116,-8 144,-14 132,-22" stroke="url(#cpWireGrad)" stroke-width="5.5" fill="none" stroke-linecap="round"/>
			<path d="M130,36 C142,26 112,15 126,5 C140,-5 110,-12 122,-20" stroke="url(#cpWireGrad)" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.4"/>
			<rect x="10" y="38" width="240" height="114" rx="21" fill="rgba(0,0,0,0.4)" transform="translate(2,5)"/>
			<rect x="10" y="38" width="240" height="114" rx="21" fill="url(#cpBodyGrad)" stroke="#484848" stroke-width="2"/>
			<rect x="14" y="42" width="232" height="28" rx="17" fill="white" opacity="0.035"/>
			<rect x="52" y="71" width="14" height="46" rx="3" fill="url(#cpDpadGrad)" stroke="#222" stroke-width="1.5"/>
			<rect x="38" y="85" width="42" height="18" rx="3" fill="url(#cpDpadGrad)" stroke="#222" stroke-width="1.5"/>
			<rect x="52" y="85" width="14" height="18" fill="#3c3c3c"/>
			<polygon points="59,75 56,80 62,80"   fill="#606060"/>
			<polygon points="59,113 56,108 62,108" fill="#606060"/>
			<polygon points="42,94 47,91 47,97"   fill="#606060"/>
			<polygon points="76,94 71,91 71,97"   fill="#606060"/>
			<rect x="102" y="93" width="24" height="10" rx="5" fill="#353535" stroke="#555" stroke-width="1.2"/>
			<text x="114" y="109" font-size="5.5" fill="#5a5a5a" text-anchor="middle" font-family="sans-serif" font-weight="700" letter-spacing="0.5">SELECT</text>
			<rect x="135" y="93" width="24" height="10" rx="5" fill="#353535" stroke="#555" stroke-width="1.2"/>
			<text x="147" y="109" font-size="5.5" fill="#5a5a5a" text-anchor="middle" font-family="sans-serif" font-weight="700" letter-spacing="0.5">START</text>
			<circle cx="192" cy="100" r="18" fill="rgba(0,0,0,0.35)" transform="translate(1,3)"/>
			<circle cx="192" cy="100" r="18" fill="url(#cpBtnRed)" stroke="#6b0a0a" stroke-width="2" filter="url(#cpShadow)"/>
			<ellipse cx="186" cy="93" rx="6" ry="4.5" fill="white" opacity="0.22" transform="rotate(-20,186,93)"/>
			<text x="192" y="105" font-size="15" font-weight="900" fill="white" text-anchor="middle" font-family="sans-serif">B</text>
			<circle cx="222" cy="85" r="18" fill="rgba(0,0,0,0.35)" transform="translate(1,3)"/>
			<circle cx="222" cy="85" r="18" fill="url(#cpBtnRed)" stroke="#6b0a0a" stroke-width="2" filter="url(#cpShadow)"/>
			<ellipse cx="216" cy="78" rx="6" ry="4.5" fill="white" opacity="0.22" transform="rotate(-20,216,78)"/>
			<text x="222" y="90" font-size="15" font-weight="900" fill="white" text-anchor="middle" font-family="sans-serif">A</text>
			<text x="127" y="70" font-size="6.5" fill="#282828" text-anchor="middle" font-family="sans-serif" font-weight="800" letter-spacing="3">NINTENDO</text>
		</svg>
	</div>

	<!-- Player 1 -->
	{@render playerSection(1, player1Input, player1KeyMap)}

	<!-- Player 2 -->
	{@render playerSection(2, player2Input, player2KeyMap)}
</div>

{#snippet playerSection(player: 1 | 2, input: PlayerInput, kmap: Record<string, number>)}
	{@const isP1   = player === 1}
	{@const assign = isP1 ? assignP1 : assignP2}

	<div class="cp-section">
		<div class="cp-player-row">
			<span class="cp-player-label">Player {player}</span>
		</div>

		<!-- Input source selector -->
		<div class="cp-source-row">
			{#if isP1}
				<!-- P1 can be keyboard or any gamepad (not none) -->
				<button
					class="cp-source-btn"
					class:active={input.type === 'keyboard'}
					onclick={() => assign({ type: 'keyboard' })}
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="14" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="6" y2="14"/><line x1="18" y1="14" x2="18" y2="14"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
					Keyboard
				</button>
			{:else}
				<!-- P2 can be none, keyboard, or any gamepad -->
				<button
					class="cp-source-btn"
					class:active={input.type === 'none'}
					onclick={() => assign({ type: 'none' })}
				>
					None
				</button>
				<button
					class="cp-source-btn"
					class:active={input.type === 'keyboard'}
					onclick={() => assign({ type: 'keyboard' })}
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="14" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="6" y2="14"/><line x1="18" y1="14" x2="18" y2="14"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
					Keys
				</button>
			{/if}

			{#each detectedGamepads as pad}
				<button
					class="cp-source-btn cp-source-btn--pad"
					class:active={input.type === 'gamepad' && input.id === pad.id}
					onclick={() => assign({ type: 'gamepad', id: pad.id })}
					title={pad.id}
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><circle cx="15" cy="13" r="0.5" fill="currentColor"/><circle cx="18" cy="11" r="0.5" fill="currentColor"/></svg>
					{pad.name}
				</button>
			{/each}
		</div>

		{#if input.type === 'keyboard'}
			<div class="cp-bindings">
				{#each NES_BUTTONS as btn}
					{@const currentKey  = keyForBit(kmap, btn.bit)}
					{@const isRebinding = kbRebind?.player === player && kbRebind?.bit === btn.bit}
					<div class="cp-row">
						<span class="cp-btn-label">{btn.label}</span>
						<button
							class="cp-key-tag"
							class:rebinding={isRebinding}
							onclick={() => { kbRebind = isRebinding ? null : { player, bit: btn.bit }; }}
						>
							{#if isRebinding}
								<span class="cp-listening">press key…</span>
							{:else}
								{currentKey ? keyLabel(currentKey) : '—'}
							{/if}
						</button>
					</div>
				{/each}
				<div class="cp-divider"></div>
				<div class="cp-row">
					<span class="cp-btn-label">Quick Save</span>
					<button
						class="cp-key-tag"
						class:rebinding={stateKeyRebind === 'save'}
						onclick={() => { stateKeyRebind = stateKeyRebind === 'save' ? null : 'save'; kbRebind = null; }}
					>
						{#if stateKeyRebind === 'save'}
							<span class="cp-listening">press key…</span>
						{:else}
							{keyLabel(quickSaveKey)}
						{/if}
					</button>
				</div>
				<div class="cp-row">
					<span class="cp-btn-label">Quick Load</span>
					<button
						class="cp-key-tag"
						class:rebinding={stateKeyRebind === 'load'}
						onclick={() => { stateKeyRebind = stateKeyRebind === 'load' ? null : 'load'; kbRebind = null; }}
					>
						{#if stateKeyRebind === 'load'}
							<span class="cp-listening">press key…</span>
						{:else}
							{keyLabel(quickLoadKey)}
						{/if}
					</button>
				</div>
				<button
					class="cp-reset-btn"
					onclick={() => {
						const emit = isP1 ? onplayer1keymapchange : onplayer2keymapchange;
						emit({ ...defaultKeyMap });
						kbRebind = null;
					}}
				>Reset to defaults</button>
			</div>

		{:else if input.type === 'gamepad'}
			{@const prof = gamepadProfiles.find(p => p.id === input.id) ?? { id: input.id, buttonMap: defaultGamepadButtonMap }}
			<div class="cp-bindings">
				{#each NES_BUTTONS as btn}
					{@const boundIdx    = gpIdxForBit(prof.buttonMap, btn.bit)}
					{@const isRebinding = gpRebind?.padId === input.id && gpRebind?.bit === btn.bit}
					<div class="cp-row">
						<span class="cp-btn-label">{btn.label}</span>
						<button
							class="cp-key-tag"
							class:rebinding={isRebinding}
							onclick={() => { gpRebind = isRebinding ? null : { padId: input.id, bit: btn.bit }; }}
						>
							{#if isRebinding}
								<span class="cp-listening">press button…</span>
							{:else}
								{boundIdx !== null ? gpBtnLabel(boundIdx) : '—'}
							{/if}
						</button>
					</div>
				{/each}
				<div class="cp-divider"></div>
				<div class="cp-row">
					<span class="cp-btn-label">Quick Save</span>
					<button
						class="cp-key-tag"
						class:rebinding={stateGpRebind?.padId === input.id && stateGpRebind?.which === 'save'}
						onclick={() => { stateGpRebind = (stateGpRebind?.which === 'save' && stateGpRebind?.padId === input.id) ? null : { padId: input.id, which: 'save' }; gpRebind = null; }}
					>
						{#if stateGpRebind?.padId === input.id && stateGpRebind?.which === 'save'}
							<span class="cp-listening">press button…</span>
						{:else}
							{prof.quickSaveBtn != null ? gpBtnLabel(prof.quickSaveBtn) : '—'}
						{/if}
					</button>
				</div>
				<div class="cp-row">
					<span class="cp-btn-label">Quick Load</span>
					<button
						class="cp-key-tag"
						class:rebinding={stateGpRebind?.padId === input.id && stateGpRebind?.which === 'load'}
						onclick={() => { stateGpRebind = (stateGpRebind?.which === 'load' && stateGpRebind?.padId === input.id) ? null : { padId: input.id, which: 'load' }; gpRebind = null; }}
					>
						{#if stateGpRebind?.padId === input.id && stateGpRebind?.which === 'load'}
							<span class="cp-listening">press button…</span>
						{:else}
							{prof.quickLoadBtn != null ? gpBtnLabel(prof.quickLoadBtn) : '—'}
						{/if}
					</button>
				</div>
				<button
					class="cp-reset-btn"
					onclick={() => {
						ongpprofilechange({ id: input.id, buttonMap: { ...defaultGamepadButtonMap }, quickSaveBtn: null, quickLoadBtn: null });
						gpRebind = null;
						stateGpRebind = null;
					}}
				>Reset to defaults</button>
			</div>
		{/if}
	</div>
{/snippet}

<style>
	.cp-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.58);
		z-index: 20;
		cursor: default;
	}

	.cp-panel {
		position: absolute;
		inset: 0;
		margin: auto;
		width: min(292px, calc(100% - 68px));
		height: fit-content;
		max-height: calc(100% - 20px);
		background: #0d0d1c;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 10px;
		overflow-y: auto;
		overflow-x: hidden;
		z-index: 21;
		display: flex;
		flex-direction: column;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.75);
	}

	.cp-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px 9px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.07);
		flex-shrink: 0;
	}

	.cp-title {
		font-size: 0.72rem;
		font-weight: 700;
		color: rgba(255, 255, 255, 0.7);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.cp-close {
		width: 22px;
		height: 22px;
		border: none;
		background: rgba(255, 255, 255, 0.07);
		border-radius: 4px;
		color: rgba(255, 255, 255, 0.5);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		flex-shrink: 0;
	}

	.cp-close:hover {
		background: rgba(255, 255, 255, 0.14);
		color: rgba(255, 255, 255, 0.85);
	}

	.cp-art {
		padding: 10px 20px 4px;
		display: flex;
		justify-content: center;
		flex-shrink: 0;
	}

	.cp-svg {
		width: 100%;
		max-width: 210px;
		overflow: visible;
	}

	.cp-divider {
		border: none;
		border-top: 1px solid rgba(255, 255, 255, 0.07);
		margin: 4px 0;
	}

	.cp-section {
		padding: 8px 14px 10px;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}

	.cp-player-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 7px;
	}

	.cp-player-label {
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.35);
	}

.cp-source-row {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-bottom: 2px;
	}

	.cp-source-btn {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 20px;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(255, 255, 255, 0.5);
		font-size: 0.68rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
		transition: border-color 0.1s, background 0.1s, color 0.1s;
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cp-source-btn svg {
		flex-shrink: 0;
	}

	.cp-source-btn:hover {
		border-color: rgba(255, 255, 255, 0.22);
		background: rgba(255, 255, 255, 0.08);
		color: rgba(255, 255, 255, 0.8);
	}

	.cp-source-btn.active {
		border-color: #4ade80;
		background: rgba(74, 222, 128, 0.1);
		color: #4ade80;
	}

	.cp-bindings {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 8px;
	}

	.cp-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.cp-btn-label {
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.55);
		min-width: 52px;
	}

	.cp-key-tag {
		min-width: 80px;
		height: 26px;
		padding: 0 10px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.05);
		color: rgba(255, 255, 255, 0.8);
		font-size: 0.72rem;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		text-align: center;
		white-space: nowrap;
		transition: border-color 0.1s, background 0.1s;
	}

	.cp-key-tag:hover {
		border-color: rgba(255, 255, 255, 0.26);
		background: rgba(255, 255, 255, 0.09);
	}

	.cp-key-tag.rebinding {
		border-color: #f87171;
		background: rgba(248, 113, 113, 0.12);
		animation: cp-pulse 0.8s ease-in-out infinite alternate;
	}

	@keyframes cp-pulse {
		from { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0); }
		to   { box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.25); }
	}

	.cp-listening {
		color: #f87171;
		font-style: italic;
		font-size: 0.65rem;
	}

	.cp-reset-btn {
		margin-top: 8px;
		width: 100%;
		height: 26px;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.03);
		color: rgba(255, 255, 255, 0.35);
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition: background 0.1s, color 0.1s;
	}

	.cp-reset-btn:hover {
		background: rgba(255, 255, 255, 0.08);
		color: rgba(255, 255, 255, 0.65);
	}
</style>

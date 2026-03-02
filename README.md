# @manybitsbyte/nesplayer-svelte

A self-contained NES emulator component for Svelte 5 / SvelteKit 2+ projects. Drop it in, pass a ROM, and play.

## Install

```sh
npm install @manybitsbyte/nesplayer-svelte
```

## Basic usage

```svelte
<script>
  import { Screen } from '@manybitsbyte/nesplayer-svelte';
</script>

<Screen style="width: 512px; height: 480px;" />
```

That's it. The built-in controls overlay includes a file picker — hover the right edge of the player and click the disk icon to load a `.nes` ROM.

The component fills its container. Set width/height on the element or a wrapping div. The canvas maintains the correct NES aspect ratio (8:7 pixel, ~1.167:1) and letter-boxes within the available space.

### Loading a ROM programmatically

If you want to serve ROMs from your own UI (a game library, a URL fetch, etc.), pass the bytes via the `rom` prop:

```svelte
<script>
  import { Screen } from '@manybitsbyte/nesplayer-svelte';

  let romBytes = $state(null);

  async function loadRom() {
    const res = await fetch('/roms/game.nes');
    romBytes = new Uint8Array(await res.arrayBuffer());
  }
</script>

<button onclick={loadRom}>Load game</button>
<Screen rom={romBytes} romName="game" style="width: 512px; height: 480px;" />
```

## Props

| Prop | Type | Default | Bindable | Description |
|------|------|---------|----------|-------------|
| `rom` | `Uint8Array \| undefined` | — | no | Raw bytes of a `.nes` ROM. Changing this value loads the new ROM. Leave unset to let the user open one via the built-in file picker. |
| `romName` | `string \| undefined` | — | no | Identifier used as the localStorage key for SRAM and quick-save state. Should be unique per game. Falls back to the filename when using the file picker. |
| `volume` | `number` | `1` | yes | Master volume, `0`–`1`. |
| `muted` | `boolean` | `false` | yes | Mute audio without changing the volume value. |
| `sampleRate` | `48000 \| 44100` | `48000` | yes | Audio output sample rate. |

## Features

### Controls overlay

Hovering the right edge of the player reveals a vertical strip of controls. All buttons show a tooltip on hover.

| Button | Action |
|--------|--------|
| Power | Toggle power on/off |
| Play / Pause | Resume or pause emulation |
| Reset | Soft reset (power stays on) |
| Volume slider | Drag to adjust master volume |
| Mute | Toggle mute |
| Insert ROM | Open a `.nes` file from disk |
| Controllers | Open the input-mapping panel |
| Region | Cycle Auto → NTSC → PAL |
| Fullscreen | Enter/exit browser fullscreen |

### Input

Player 1 defaults to keyboard. Player 2 defaults to none (unassigned). Both can be switched to any connected gamepad.

**Default keyboard bindings (Player 1)**

| Key | NES button |
|-----|-----------|
| Z | B |
| X | A |
| Right Shift | Select |
| Enter | Start |
| Arrow keys | D-Pad |
| F5 | Quick Save |
| F7 | Quick Load |

All bindings are fully remappable per-player from the Controllers panel. Settings persist to `localStorage`.

### Gamepad support

- Connects any Gamepad API controller automatically when it is used in-game.
- Supports two players simultaneously on separate controllers.
- Each controller gets its own button mapping profile, persisted to `localStorage`.
- Quick Save and Quick Load can each be bound to a gamepad button.
- If a controller disconnects mid-game, emulation pauses and a dialog prompts the player to switch to keyboard or wait for reconnect.

### Save states (quick save / load)

Press **F5** to save the current emulator state to memory and to `localStorage`. Press **F7** to restore it. The saved state survives page reloads. A toast notification confirms each operation.

The state is stored under the key `nesplayer-<romName>.state`, where `romName` is the value passed to the `romName` prop (or the filename when the user opens a ROM via the file picker). Use a consistent, URL-safe string as `romName` so saves persist across sessions reliably.

### Battery save (SRAM)

ROMs with battery-backed RAM (e.g. Zelda, Crystalis) automatically save SRAM to `localStorage` on page unload and restore it when the same ROM is loaded again. Keys used:

| Key | Contents |
|-----|----------|
| `nesplayer-<romName>.sram` | Battery-backed RAM (iNES mapper SRAM) |
| `nesplayer-<romName>.flash` | Mapper 30 flash storage |
| `nesplayer-<romName>.state` | Quick-save state snapshot |

### Supported mappers

| Mapper | Common boards / games |
|--------|-----------------------|
| NROM (0) | Super Mario Bros., Donkey Kong, most early titles |
| MMC1 (1) | Mega Man 2, Zelda, Metroid, Castlevania II |
| MMC3 (4) | Super Mario Bros. 3, Mega Man 3–6, Kirby's Adventure |
| AXROM / ANROM (7) | Battletoads, Rare titles ⚠️ |
| Mapper 30 | UNROM 512 — homebrew and modern NES releases |

ROMs using other mappers will not load correctly. Famicom-specific features (expansion audio, Famicom Disk System, four-player adapters) are not currently supported.

> ⚠️ **Battletoads** and **Wizards & Warriors** are currently affected by a sprite-zero hit detection bug. Battletoads hangs on the title screen before the first level; Wizards & Warriors exhibits screen flickering. Both use Mapper 7 and share the same underlying PPU timing issue, which is under active investigation.

### Region

The Region button cycles **Auto → NTSC → PAL**.

- **Auto** reads the region field from the ROM header. iNES 2.0 ROMs include this field and will be detected correctly. iNES 1.0 ROMs do not include a region field, so Auto will default to NTSC — PAL games distributed as iNES 1.0 need to be set manually.
- **NTSC** and **PAL** force the region regardless of what the header says.

---

## Server requirements

### Audio

Audio uses the Web Audio API with `SharedArrayBuffer` for a lock-free ring buffer between the emulator and the audio worklet. `SharedArrayBuffer` requires cross-origin isolation headers on every page that embeds the player:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers the component still works — the screen renders and input is accepted — but audio is silently disabled and a warning is logged to the console.

> **Note:** These headers restrict how your page can interact with cross-origin resources (iframes, popups, etc.). If your site relies on OAuth redirects, embedded third-party iframes, or similar cross-origin communication, audit the impact before enabling them.

---

#### `adapter-static` — Vite dev server

Add to `vite.config.ts`:

```ts
server: {
  headers: {
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
```

#### `adapter-static` — Netlify

Add to `netlify.toml`:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy   = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
```

#### `adapter-static` — Vercel

Add to `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy",   "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

#### `adapter-node`

Set the headers in `src/hooks.server.ts`. This covers every HTML page response and is the only change needed for production:

```ts
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
    const response = await resolve(event);
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return response;
};
```

For the dev server, also add the `server.headers` block to `vite.config.ts` as shown in the static section above.

If you offload static assets to a CDN, the CDN-hosted `.js` and `.wasm` files must also send:

```
Cross-Origin-Resource-Policy: cross-origin
```

Without it, COEP will block those assets from loading. If you serve statics from the same Node origin (the default), no extra config is needed.

If you use a reverse proxy (nginx, Caddy, etc.), make sure it is configured to pass response headers through unchanged.

### WebGL

The screen is rendered with WebGL (WebGL 1). Any browser that supports Svelte 5 supports WebGL, so no additional configuration is needed.

---

## Browser support

Requires Chrome 85+, Firefox 79+, or Safari 15+. These are the minimum versions supported by the underlying WASM runtime.

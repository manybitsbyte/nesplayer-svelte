export const audioWorkletSrc = `
const RING_SIZE   = 4096;
const PRE_BUFFER  = 1024;
const TARGET_FILL = 1536;
const SMOOTH      = 0.005;
const RATE_GAIN   = 0.000008;
const MAX_ADJUST  = 0.005;
const FADE_RATE   = 0.97;
const MP_BUF_SIZE = 16384;

class NESAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.headerView = null;
        this.ringView   = null;
        this.ready      = false;
        this.primed     = false;
        this.lastSample = 0;
        this.smoothFill = TARGET_FILL;
        this.readBuf    = new Float32Array(192);
        this.mpBuf      = new Float32Array(MP_BUF_SIZE);
        this.mpHead     = 0;
        this.mpTail     = 0;
        this.mpMode     = false;
        this.mpPrimed   = false;

        this.port.onmessage = (e) => {
            if (e.data.type === 'init') {
                const sab       = e.data.sharedBuffer;
                this.headerView = new Int32Array(sab, 0, 2);
                this.ringView   = new Float32Array(sab, 8, RING_SIZE);
                this.mpMode     = false;
                this.ready      = true;
            } else if (e.data.type === 'init-mp') {
                this.mpMode = true;
                this.ready  = true;
            } else if (e.data.type === 'push') {
                const s     = e.data.samples;
                const avail = MP_BUF_SIZE - (this.mpHead - this.mpTail);
                const count = Math.min(s.length, avail);
                for (let i = 0; i < count; i++) {
                    this.mpBuf[(this.mpHead + i) % MP_BUF_SIZE] = s[i];
                }
                this.mpHead += count;
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length === 0) { return true; }

        const left   = output[0];
        const right  = output.length > 1 ? output[1] : null;
        const frames = left.length;

        if (!this.ready) {
            left.fill(0);
            if (right) { right.fill(0); }
            return true;
        }

        if (this.mpMode) {
            return this._processMp(left, right, frames);
        }

        const writePos  = Atomics.load(this.headerView, 0);
        const readPos   = Atomics.load(this.headerView, 1);
        const available = (writePos - readPos + RING_SIZE) % RING_SIZE;

        if (!this.primed) {
            if (available < PRE_BUFFER) {
                left.fill(0);
                if (right) { right.fill(0); }
                return true;
            }
            this.primed     = true;
            this.smoothFill = available;
        }

        if (available === 0) {
            let held = this.lastSample;
            for (let i = 0; i < frames; i++) {
                held   *= FADE_RATE;
                left[i] = held;
                if (right) { right[i] = held; }
            }
            this.lastSample = held;
            return true;
        }

        this.smoothFill += SMOOTH * (available - this.smoothFill);
        const fillError = this.smoothFill - TARGET_FILL;
        const speedAdj  = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, fillError * RATE_GAIN));
        let readCount   = Math.round(frames * (1.0 + speedAdj));
        readCount       = Math.max(1, Math.min(readCount, available));

        const buf = this.readBuf;
        for (let i = 0; i < readCount; i++) {
            buf[i] = this.ringView[(readPos + i) % RING_SIZE];
        }

        if (readCount === frames) {
            for (let i = 0; i < frames; i++) {
                const s  = buf[i];
                left[i]  = s;
                if (right) { right[i] = s; }
            }
        } else {
            const ratio = readCount / frames;
            for (let i = 0; i < frames; i++) {
                const srcPos = i * ratio;
                const idx    = srcPos | 0;
                const frac   = srcPos - idx;
                const s0     = buf[idx];
                const s1     = idx + 1 < readCount ? buf[idx + 1] : s0;
                const s      = s0 + frac * (s1 - s0);
                left[i]      = s;
                if (right) { right[i] = s; }
            }
        }

        this.lastSample = left[frames - 1];
        Atomics.store(this.headerView, 1, (readPos + readCount) % RING_SIZE);
        return true;
    }

    _processMp(left, right, frames) {
        const available = this.mpHead - this.mpTail;

        if (!this.mpPrimed) {
            if (available < PRE_BUFFER) {
                left.fill(0);
                if (right) { right.fill(0); }
                return true;
            }
            this.mpPrimed = true;
        }

        if (available === 0) {
            let held = this.lastSample;
            for (let i = 0; i < frames; i++) {
                held   *= FADE_RATE;
                left[i] = held;
                if (right) { right[i] = held; }
            }
            this.lastSample = held;
            return true;
        }

        const toRead = Math.min(frames, available);
        for (let i = 0; i < toRead; i++) {
            const s  = this.mpBuf[(this.mpTail + i) % MP_BUF_SIZE];
            left[i]  = s;
            if (right) { right[i] = s; }
        }
        this.mpTail += toRead;

        if (toRead < frames) {
            let held = toRead > 0 ? left[toRead - 1] : this.lastSample;
            for (let i = toRead; i < frames; i++) {
                held   *= FADE_RATE;
                left[i] = held;
                if (right) { right[i] = held; }
            }
        }

        this.lastSample = left[frames - 1];
        return true;
    }
}

registerProcessor('nes-audio-processor', NESAudioProcessor);
`;

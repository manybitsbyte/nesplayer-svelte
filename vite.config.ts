import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 4005,
		headers: {
			'Cross-Origin-Opener-Policy':   'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		}
	}
});

import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://user.github.io/repo-name/) without configuration.
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600, // Phaser is a single large chunk; that's fine
  },
});

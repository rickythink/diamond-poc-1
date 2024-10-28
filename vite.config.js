import { defineConfig } from 'vite'
import topLevelAwait from 'vite-plugin-top-level-await'
import glsl from 'vite-plugin-glsl'

export default defineConfig({
  plugins:
  [
      topLevelAwait(),
      //restart({ restart: [ '../static/**', ] }), // Restart server on static file change
      glsl() // Handle shader files
  ],
  base: './',
})
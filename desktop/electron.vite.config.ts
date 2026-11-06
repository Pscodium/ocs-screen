import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Versão do app embutida no renderer — vai no POST /rooms (`appVersion`) pra diagnóstico/listagem.
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    // Porta fixa (o viewer já usa 5173) — o backend libera essa origem no CORS em dev.
    server: { port: 5174, strictPort: true },
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
  },
});

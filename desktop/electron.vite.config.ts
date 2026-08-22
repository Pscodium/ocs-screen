import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

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
  },
});

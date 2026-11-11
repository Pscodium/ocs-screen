import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string })
  .version;

export default defineConfig({
  plugins: [
    react(),
    // `version.json` no build — a página aberta compara com o próprio __APP_VERSION__ e oferece
    // recarregar quando sai versão nova (ver components/UpdateToast.tsx).
    {
      name: "emit-version",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: appVersion }) });
      },
    },
  ],
  server: { port: 5173 },
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
});

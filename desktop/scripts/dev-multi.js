// Abre uma segunda janela do app junto com `electron-vite dev`, pra testar host+espectador no
// mesmo PC sem precisar de duas máquinas (ver main/index.ts — OPEN_TEST_WINDOW).
const { spawn } = require("child_process");

const child = spawn("electron-vite", ["dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, OPEN_TEST_WINDOW: "1" },
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

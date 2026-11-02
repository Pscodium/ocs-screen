// Registra/atualiza os slash commands do bot (/avisar, /parar, /painel-avisos). Rodar uma vez, e de
// novo só quando COMMANDS mudar: `npm run discord:register`.
import "../env.js";
import { registerCommands } from "../services/discordNotify.js";

await registerCommands();
console.log("Comandos do Discord registrados.");

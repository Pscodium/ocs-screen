// Gera o pacote da Microsoft Store. A identidade vem de variáveis de ambiente e é injetada aqui
// porque o electron-builder NÃO expande ${env.X} nos campos do bloco appx do .yml (passa o texto
// literal e falha com "identityName.Id cat be consists of alpha-numeric...").
const { build, Platform } = require("electron-builder");

const env = {
  identityName: "MSSTORE_IDENTITY_NAME",
  publisher: "MSSTORE_PUBLISHER",
  publisherDisplayName: "MSSTORE_PUBLISHER_DISPLAY_NAME",
};
const missing = Object.values(env).filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Faltam variáveis de ambiente: ${missing.join(", ")}\n` +
      "Copie os valores de Partner Center → Gerenciamento de produto → Identidade do produto."
  );
  process.exit(1);
}

build({
  targets: Platform.WINDOWS.createTarget("appx"),
  publish: "never",
  config: {
    // Sem extends o config passado aqui substituiria o electron-builder.yml inteiro; com ele, os
    // campos abaixo são mesclados ao bloco appx do .yml.
    extends: "electron-builder.yml",
    appx: {
      identityName: process.env[env.identityName],
      publisher: process.env[env.publisher],
      publisherDisplayName: process.env[env.publisherDisplayName],
    },
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

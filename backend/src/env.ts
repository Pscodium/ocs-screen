// Precisa ser o PRIMEIRO import em server.ts. Em ESM, imports são hoisted e avaliados antes de
// qualquer código do próprio arquivo — chamar loadEnvFile() diretamente em server.ts executava
// DEPOIS de config.ts já ter lido (e cacheado) process.env vazio. Isolar num módulo próprio e
// importá-lo primeiro garante que ele roda antes de qualquer outro import ler process.env.
try {
  process.loadEnvFile();
} catch {
  // sem .env local — em produção as env vars vêm do ambiente (EasyPanel), não de arquivo
}

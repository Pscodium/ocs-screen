# Envia o .msix gerado por `npm run dist:store` como nova submissão na Microsoft Store.
# Usa o Microsoft Store Developer CLI (`winget install "Microsoft Store Developer CLI"`).
#
# Variáveis de ambiente (Partner Center → Configurações da conta → Gerenciamento de usuários →
# Aplicativos do Microsoft Entra; o app precisa do papel "Gerente"):
#   MSSTORE_TENANT_ID, MSSTORE_SELLER_ID, MSSTORE_CLIENT_ID, MSSTORE_CLIENT_SECRET
#   MSSTORE_PRODUCT_ID  (Store ID do app, ex.: 9NXXXXXXXXXX)
$ErrorActionPreference = "Stop"

foreach ($name in "MSSTORE_TENANT_ID", "MSSTORE_SELLER_ID", "MSSTORE_CLIENT_ID", "MSSTORE_CLIENT_SECRET", "MSSTORE_PRODUCT_ID") {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Variável $name não definida" }
}
if (-not (Get-Command msstore -ErrorAction SilentlyContinue)) {
    throw "msstore não encontrado — instale com: winget install `"Microsoft Store Developer CLI`""
}

$version = (Get-Content "$PSScriptRoot\..\package.json" -Raw | ConvertFrom-Json).version
$msix = Get-ChildItem "$PSScriptRoot\..\dist" -Filter "*-$version.appx" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $msix) { $msix = Get-ChildItem "$PSScriptRoot\..\dist" -Filter "*-$version.msix" | Select-Object -First 1 }
if (-not $msix) { throw "Pacote da versão $version não encontrado em dist/ — rode npm run dist:store" }

msstore reconfigure --tenantId $env:MSSTORE_TENANT_ID --sellerId $env:MSSTORE_SELLER_ID `
    --clientId $env:MSSTORE_CLIENT_ID --clientSecret $env:MSSTORE_CLIENT_SECRET
if ($LASTEXITCODE -ne 0) { throw "msstore reconfigure falhou" }

# publish cria a submissão, sobe o pacote e envia pra certificação (substitui os pacotes anteriores).
msstore publish $msix.FullName --appId $env:MSSTORE_PRODUCT_ID
if ($LASTEXITCODE -ne 0) { throw "msstore publish falhou" }

Write-Host "Versão $version enviada pra certificação da Store."

# Instala localmente o .appx gerado por `npm run dist:store` pra testar antes de enviar à Store.
# O pacote não é assinado (a Store assina na publicação), então em vez de instalar o .appx ele é
# extraído e o AppxManifest.xml registrado direto — exige o Modo de desenvolvedor do Windows ativo.
$ErrorActionPreference = "Stop"

$version = (Get-Content "$PSScriptRoot\..\package.json" -Raw | ConvertFrom-Json).version
$appx = Join-Path "$PSScriptRoot\..\dist" "Screen Share-$version.appx"
if (-not (Test-Path $appx)) { throw "Pacote não encontrado: $appx — rode npm run dist:store" }

$dir = Join-Path "$PSScriptRoot\..\dist" "appx-local"
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
New-Item -ItemType Directory $dir | Out-Null
tar -xf $appx -C $dir
if ($LASTEXITCODE -ne 0) { throw "Falha ao extrair $appx" }

# O formato do pacote guarda nomes com URL-encoding ("Screen%20Share.exe") e o tar não decodifica —
# sem renomear, o manifesto aponta pra um .exe que não existe e o app simplesmente não abre.
Get-ChildItem $dir -Recurse | Where-Object { $_.Name -match "%[0-9A-Fa-f]{2}" } |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { Rename-Item -LiteralPath $_.FullName -NewName ([Uri]::UnescapeDataString($_.Name)) }

# Arquivos de empacotamento que não podem estar presentes num registro de pasta solta.
foreach ($name in "AppxBlockMap.xml", "AppxSignature.p7x", "[Content_Types].xml") {
    Remove-Item -LiteralPath (Join-Path $dir $name) -ErrorAction SilentlyContinue
}

Add-AppxPackage -Register (Join-Path $dir "AppxManifest.xml")
Write-Host "Instalado. Abra 'Screen Share' pelo menu Iniciar. Pra remover: Get-AppxPackage `$env:MSSTORE_IDENTITY_NAME | Remove-AppxPackage"

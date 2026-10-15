#!/bin/sh
# Rebuild incremental do addon nativo (capture_core.node). Apaga os arquivos de LTCG incremental
# antes — sem isso o link falha quase sempre com "LNK1103: depurando informação corrompida".
# `clean` como 1º argumento apaga os .obj também (necessário depois de remover/renomear fonte).
# Imprime só o resultado (erros de compilação/link ou "gyp info ok").
REPO="${OCS_REPO:-$(cd "$(dirname "$0")/../../../.." && pwd)}"
cd "$REPO/desktop/native/capture-core" || exit 1
[ "$1" = clean ] && rm -rf build/Release/obj
rm -f build/Release/capture_core.iobj build/Release/capture_core.ipdb build/Release/capture_core.pdb
../../node_modules/.bin/node-gyp build 2>&1 | grep -E "error C[0-9]|error LNK|fatal error|Erro\(s\)|gyp info ok|gyp ERR! stack Error" | sort -u | head -30

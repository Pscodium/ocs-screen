#pragma once

#include <unknwn.h>

// Isola o uso de `<codecapi.h>` (`ICodecAPI`) longe de `<mfidl.h>`/`<mftransform.h>` — incluir os
// dois no mesmo arquivo dá `error C2027: uso de tipo indefinido 'ICodecAPI'`: um dos headers de
// Media Foundation puxa `<strmif.h>` transitivamente, que FORWARD-declara `ICodecAPI` e ativa o
// guard de inclusão — quando `<codecapi.h>` é incluído depois, o guard já tá "satisfeito" e a
// definição completa da interface nunca roda (bug real medido tentando compilar
// SoftwareEncoderCore.cpp). Arquivo isolado = nenhum header de MF nem de DirectShow nesse TU.
namespace CodecApiHelper {
bool IsSupported(IUnknown* transform);
bool SetRateControlCbr(IUnknown* transform);
bool SetMeanBitRate(IUnknown* transform, unsigned long bitrateBps);
bool SetLowLatency(IUnknown* transform);
bool SetGopSize(IUnknown* transform, unsigned long gopSize);
bool ForceKeyframe(IUnknown* transform);
} // namespace CodecApiHelper

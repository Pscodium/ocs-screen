#include "CodecApiHelper.h"
#include <windows.h>
#include <icodecapi.h> // interface ICodecAPI de verdade (codecapi.h só tem as GUIDs/constantes)
#include <initguid.h>
#include <codecapi.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace {

ComPtr<ICodecAPI> GetCodecApi(IUnknown* transform) {
    ComPtr<ICodecAPI> api;
    if (transform) transform->QueryInterface(IID_PPV_ARGS(&api));
    return api;
}

bool SetU32(IUnknown* transform, const GUID& guid, ULONG value) {
    auto api = GetCodecApi(transform);
    if (!api) return false;
    VARIANT var{};
    var.vt = VT_UI4;
    var.ulVal = value;
    return SUCCEEDED(api->SetValue(&guid, &var));
}

bool SetBool(IUnknown* transform, const GUID& guid) {
    auto api = GetCodecApi(transform);
    if (!api) return false;
    VARIANT var{};
    var.vt = VT_BOOL;
    var.boolVal = VARIANT_TRUE;
    return SUCCEEDED(api->SetValue(&guid, &var));
}

} // namespace

namespace CodecApiHelper {

bool IsSupported(IUnknown* transform) {
    return static_cast<bool>(GetCodecApi(transform));
}

bool SetRateControlCbr(IUnknown* transform) {
    return SetU32(transform, CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
}

bool SetMeanBitRate(IUnknown* transform, unsigned long bitrateBps) {
    return SetU32(transform, CODECAPI_AVEncCommonMeanBitRate, bitrateBps);
}

bool SetLowLatency(IUnknown* transform) {
    return SetBool(transform, CODECAPI_AVLowLatencyMode);
}

bool SetGopSize(IUnknown* transform, unsigned long gopSize) {
    return SetU32(transform, CODECAPI_AVEncMPVGOPSize, gopSize);
}

bool ForceKeyframe(IUnknown* transform) {
    return SetU32(transform, CODECAPI_AVEncVideoForceKeyFrame, 1);
}

} // namespace CodecApiHelper

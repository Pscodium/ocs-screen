#pragma once

// Codec de vídeo ativo no pipeline nativo (captura→encode→transporte→decode) — compartilhado
// entre EncoderCore/SoftwareEncoderCore (capture-core, decide o que CODIFICAR) e TransportCore
// (transport-core, detecção de keyframe no bitstream é diferente por codec: NAL de 1 byte tipo 5
// no H.264 vs cabeçalho de 2 bytes com tipo IRAP 16-23 no HEVC). Ver docs/NATIVE_CAPTURE.md
// Fase 3 "HEVC".
enum class VideoCodecType {
    H264,
    HEVC,
};

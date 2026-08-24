{
  "targets": [
    {
      "target_name": "capture_core",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/addon.cpp",
            "src/CaptureCore.cpp",
            "src/EncoderCore.cpp",
            "vendor/nvenc/NvEncoder.cpp",
            "vendor/nvenc/NvEncoderD3D11.cpp"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "vendor/nvenc",
            "vendor/nvenc/Interface"
          ],
          "libraries": [
            "d3d11.lib",
            "dxgi.lib",
            "user32.lib",
            "gdi32.lib",
            "avrt.lib",
            "<(module_root_dir)/vendor/nvenc/Lib/nvencodeapi.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}

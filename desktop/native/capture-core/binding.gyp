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
            "src/SoftwareEncoderCore.cpp",
            "src/CodecApiHelper.cpp",
            "vendor/nvenc/NvEncoder.cpp",
            "vendor/nvenc/NvEncoderD3D11.cpp",
            "../transport-core/src/TransportCore.cpp"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "vendor/nvenc",
            "vendor/nvenc/Interface",
            "../transport-core/src",
            "C:/vcpkg/installed/x64-windows/include"
          ],
          "libraries": [
            "d3d11.lib",
            "dxgi.lib",
            "user32.lib",
            "gdi32.lib",
            "avrt.lib",
            "ole32.lib",
            "mfplat.lib",
            "mfuuid.lib",
            "<(module_root_dir)/vendor/nvenc/Lib/nvencodeapi.lib",
            "C:/vcpkg/installed/x64-windows/lib/datachannel.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          },
          "copies": [
            {
              "destination": "<(PRODUCT_DIR)",
              "files": [
                "C:/vcpkg/installed/x64-windows/bin/datachannel.dll",
                "C:/vcpkg/installed/x64-windows/bin/juice.dll",
                "C:/vcpkg/installed/x64-windows/bin/srtp2.dll",
                "C:/vcpkg/installed/x64-windows/bin/libcrypto-3-x64.dll",
                "C:/vcpkg/installed/x64-windows/bin/libssl-3-x64.dll"
              ]
            }
          ]
        }]
      ]
    }
  ]
}

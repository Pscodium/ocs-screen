{
  "targets": [
    {
      "target_name": "transport_core",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/addon.cpp",
            "src/TransportCore.cpp"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "C:/vcpkg/installed/x64-windows/include"
          ],
          "libraries": [
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
              "files": ["C:/vcpkg/installed/x64-windows/bin/datachannel.dll"]
            }
          ]
        }]
      ]
    }
  ]
}

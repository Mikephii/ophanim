#!/usr/bin/env bash
# Print runtime ABI info for the current environment.
#
# Run this inside an editor's integrated terminal to discover its Electron ABI.
# The ABI value is what the native-loader uses to select the correct binary.
#
# Usage: ./scripts/detect-abi.sh
#
# For editors without a terminal, open DevTools (Help > Toggle Developer Tools)
# and run: console.log(process.versions.modules)
echo "Platform:    $(node -p 'process.platform')"
echo "Arch:        $(node -p 'process.arch')"
echo "Node.js:     $(node -p 'process.versions.node')"
echo "Electron:    $(node -p 'process.versions.electron || "N/A"')"
echo "ABI:         $(node -p 'process.versions.modules')"
echo "V8:          $(node -p 'process.versions.v8')"

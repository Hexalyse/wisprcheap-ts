# Tray helper for wisprcheap. Started by src/tray.ts; talks to it over stdin/stdout (see TrayHost.cs).
param([Parameter(Mandatory = $true)][string]$IconDir)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'TrayHost.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing
[WisprTray]::Run($IconDir)

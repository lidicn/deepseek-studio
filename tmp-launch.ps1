$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Start-Process -FilePath 'E:\NAS\deepseek-studio\src-tauri\target\debug\deepseek-studio.exe'
Start-Sleep -Seconds 12
try {
  $targets = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5
  $targets | ForEach-Object { Write-Output ("target: " + $_.type + " | " + $_.url) }
} catch {
  Write-Output ("CDP_FAIL " + $_.Exception.Message)
}

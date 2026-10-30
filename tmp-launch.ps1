$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
Start-Process -FilePath 'E:/NAS/deepseek-studio/src-tauri/target/release/deepseek-studio.exe'
Start-Sleep -Seconds 6
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9223/json/version' -UseBasicParsing -TimeoutSec 5
    Write-Output ('CDP OK: ' + $r.StatusCode)
    Write-Output $r.Content
} catch {
    Write-Output ('CDP FAIL: ' + $_.Exception.Message)
}

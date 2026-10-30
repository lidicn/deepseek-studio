Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
Start-Process -FilePath 'E:/NAS/deepseek-studio/src-tauri/target/release/deepseek-studio.exe'
Start-Sleep -Seconds 6
foreach ($port in 9222, 9223) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 5
        Write-Output ("CDP OK on " + $port + ": " + $r.StatusCode)
        Write-Output $r.Content
        break
    } catch {
        Write-Output ("CDP " + $port + " FAIL: " + $_.Exception.Message)
    }
}

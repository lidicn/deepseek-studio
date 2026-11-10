# Offline simulation: release-chain retry loop (20261110 发版链加固)
# Covers 5 scenarios: 504-retryable, 403-not-retryable, small-package,
#   NORMAL-package (real sizes, must succeed), THRESHOLD-BUMPED (must fail = negative control)
# Real package sizes measured 2026-11-10: nsis-3.11.zip=2,361,546 B / wix314-binaries.zip=41,282,726 B
# Not committed to CI — used for local verification only.
$ErrorActionPreference = 'Stop'

# Real package sizes (measured 2026-11-10, HEAD 200 via Invoke-WebRequest)
$REAL_NSIS_SIZE = 2361546
$REAL_WIX_SIZE = 41282726

# Real thresholds (must match release.yml)
$NSIS_MIN = 1500000
$WIX_MIN = 30000000

$maxAttempts = 5
$realBackoffSecs = @(10, 20, 40, 80)  # real values, printed but not slept (sim only)

function Test-Retryable([int]$code) {
  return ($code -ge 500) -or ($code -eq 429)
}

function Simulate-Download([string]$url, [int64]$pkgSize) {
  if ($url -match 'SIM504') {
    throw [System.Net.WebException]::new("The remote server returned an error: (504) Gateway Timeout")
  }
  if ($url -match 'SIM403') {
    throw [System.Net.WebException]::new("The remote server returned an error: (403) Forbidden")
  }
  # Return the real (or bumped) package size
  return @{ Size = $pkgSize; ExtractOK = $true }
}

$scenarios = @(
  @{ name='504-retryable'; url='https://example.com/SIM504/nsis.zip'; pkgSize=$REAL_NSIS_SIZE; minBytes=$NSIS_MIN; expect='exhausted' },
  @{ name='403-not-retryable'; url='https://example.com/SIM403/wix.zip'; pkgSize=$REAL_WIX_SIZE; minBytes=$WIX_MIN; expect='aborted' },
  @{ name='small-package'; url='https://example.com/REAL/nsis.zip'; pkgSize=100; minBytes=$NSIS_MIN; expect='exhausted' },
  @{ name='normal-nsis'; url='https://example.com/REAL/nsis.zip'; pkgSize=$REAL_NSIS_SIZE; minBytes=$NSIS_MIN; expect='success' },
  @{ name='normal-wix'; url='https://example.com/REAL/wix.zip'; pkgSize=$REAL_WIX_SIZE; minBytes=$WIX_MIN; expect='success' },
  @{ name='threshold-bumped-nsis'; url='https://example.com/REAL/nsis.zip'; pkgSize=$REAL_NSIS_SIZE; minBytes=2400000; expect='exhausted' }
)

foreach ($s in $scenarios) {
  Write-Host "=== Scenario: $($s.name) (expect=$($s.expect)) ==="
  $ok = $false
  $aborted = $false
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      $r = Simulate-Download $s.url $s.pkgSize
      Write-Host ("  attempt {0}: downloaded {1} B (threshold={2})" -f $attempt, $r.Size, $s.minBytes)
      if ($r.Size -lt $s.minBytes) {
        Write-Host ("  attempt {0}: too small ({1} < {2}) - discarding" -f $attempt, $r.Size, $s.minBytes)
        throw "size below minimum"
      }
      if (-not $r.ExtractOK) {
        Write-Host ("  attempt {0}: extracted but marker missing - discarding" -f $attempt)
        throw "marker missing"
      }
      $ok = $true
      Write-Host ("  attempt {0}: SUCCESS" -f $attempt)
      break
    } catch {
      $msg = $_.Exception.Message
      $code = $null
      if ($msg -match '\((\d+)\)') { $code = [int]$Matches[1] }
      Write-Host ("  attempt {0}/{1} failed: HTTP={2} msg={3}" -f $attempt, $maxAttempts, $code, $msg)
      if ($code -and -not (Test-Retryable $code)) {
        Write-Host "  HTTP $code not retryable - ABORT"
        $aborted = $true
        break
      }
      if ($attempt -lt $maxAttempts) {
        $wait = $realBackoffSecs[$attempt - 1]
        Write-Host ("  backing off {0}s (real value, not slept in sim)" -f $wait)
      }
    }
  }
  if ($ok) {
    Write-Host "  RESULT: success"
  } elseif ($aborted) {
    Write-Host "  RESULT: aborted after non-retryable"
  } else {
    Write-Host "  RESULT: exhausted $maxAttempts attempts"
  }
  Write-Host ''
}
Write-Host "=== Simulation complete ==="

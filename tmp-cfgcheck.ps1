$c = Get-Content "$env:USERPROFILE\.config\deepseek-studio\config.json" | ConvertFrom-Json
Write-Output ("cfg_token_len=" + $c.token.Length)
Write-Output ("cfg_keys=" + (($c.PSObject.Properties.Name) -join ','))
Write-Output ("cfg_policyMode=" + $c.policyMode)
Write-Output ("cfg_workspaceRoot=" + $c.workspaceRoot)

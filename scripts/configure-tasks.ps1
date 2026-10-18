param([switch]$Register)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$templateRoot = Join-Path $projectRoot 'deploy\windows'
$destination = Join-Path $projectRoot 'tmp\tasks'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$nodeExe = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$tasks = @{
    'moneysaver-task' = 'MoneySaver-Tzarim'
    'moneysaver-backup-task' = 'MoneySaver-Backup'
    'moneysaver-watchdog-task' = 'MoneySaver-Watchdog'
}
foreach ($item in $tasks.GetEnumerator()) {
    $template = Get-Content -LiteralPath (Join-Path $templateRoot ($item.Key + '.template.xml')) -Raw
    $template = $template.Replace('__USER_ID__', [Security.SecurityElement]::Escape($identity))
    $template = $template.Replace('__PROJECT_ROOT__', [Security.SecurityElement]::Escape($projectRoot))
    $template = $template.Replace('__NODE_EXE__', [Security.SecurityElement]::Escape($nodeExe))
    $target = Join-Path $destination ($item.Key + '.xml')
    [IO.File]::WriteAllText($target, $template, [Text.Encoding]::Unicode)
    if ($Register) {
        & schtasks /Create /TN $item.Value /XML $target /F
        if ($LASTEXITCODE -ne 0) { throw "Task registration failed: $($item.Value)" }
    }
}
Write-Output 'Generated local UTF-16 LE task files in tmp/tasks. Registration occurs only with -Register.'

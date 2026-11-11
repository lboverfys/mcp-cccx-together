[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [string[]]$CodexArguments = @()
)

$ErrorActionPreference = 'Stop'
$teamRoot = $PSScriptRoot
$teamConfig = Get-Content -LiteralPath (Join-Path $teamRoot 'team.config.json') -Raw | ConvertFrom-Json
$projectDirectory = (Resolve-Path -LiteralPath $ProjectPath).Path
$nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$environmentNames = @(
    'CODEX_THREAD_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_ATTRIBUTION_HEADER', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'
)
$providerEnvironmentNames = Get-ChildItem Env: | Where-Object {
    $_.Name -match '^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_|VERTEX_|AZURE_)'
} | Select-Object -ExpandProperty Name
$environmentNames = @(@($environmentNames) + @($providerEnvironmentNames) | Sort-Object -Unique)
$values = [ordered]@{
    command = $nodeExecutable
    args = @((Join-Path $teamRoot 'src\server.mjs'), (Join-Path $teamRoot 'team.config.json'))
    cwd = $teamRoot
    startup_timeout_sec = 15
    tool_timeout_sec = 40
    env_vars = $environmentNames
}
$overrides = @()
foreach ($key in $values.Keys) {
    $encodedValue = ConvertTo-Json -InputObject $values[$key] -Compress
    $overrides += @('-c', "mcp_servers.cc_team.$key=$encodedValue")
}

# 仅本次 Codex 启动生效，不改用户级配置、PATH 或模型设置。
& $teamConfig.codexExecutable -C $projectDirectory @overrides @CodexArguments
exit $LASTEXITCODE

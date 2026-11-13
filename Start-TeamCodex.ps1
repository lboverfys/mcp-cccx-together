[CmdletBinding()]
param(
    [string]$ProjectPath = (Get-Location).Path,
    [string[]]$CodexArguments = @()
)

$ErrorActionPreference = 'Stop'
$teamRoot = $PSScriptRoot
$projectDirectory = (Resolve-Path -LiteralPath $ProjectPath).Path
$nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$cliPath = Join-Path $teamRoot 'src/cli.mjs'
$registrationJson = & $nodeExecutable $cliPath print-config
if ($LASTEXITCODE -ne 0) { throw '无法生成团队 MCP 配置，请运行 node src/cli.mjs doctor 检查环境。' }
$registration = ($registrationJson | ConvertFrom-Json).mcpServers.cc_team
$configModule = ([System.Uri]::new((Join-Path $teamRoot 'src/config.mjs'))).AbsoluteUri
$resolvedConfig = & $nodeExecutable --input-type=module -e 'const { loadConfig } = await import(process.argv[1]); process.stdout.write(JSON.stringify(loadConfig()));' $configModule
if ($LASTEXITCODE -ne 0) { throw '无法读取团队配置。' }
$teamConfig = $resolvedConfig | ConvertFrom-Json
if (-not $teamConfig.codexExecutable) { throw '未找到 Codex，请先安装并配置 Codex CLI。' }
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
# 团队配置里 provider 通过 envFrom 引用的凭据变量也需要转发给 MCP。
$providerSourceNames = @()
if ($teamConfig.providers) {
    foreach ($provider in $teamConfig.providers.PSObject.Properties) {
        if ($provider.Value.envFrom) { $providerSourceNames += @($provider.Value.envFrom.PSObject.Properties | ForEach-Object { $_.Value }) }
    }
}
$environmentNames = @(@($environmentNames) + @($providerEnvironmentNames) + @($providerSourceNames) | Sort-Object -Unique)
$values = [ordered]@{
    command = $nodeExecutable
    args = @($registration.args)
    cwd = $teamRoot
    startup_timeout_sec = 15
    tool_timeout_sec = 600
    env_vars = $environmentNames
    # 团队工具直接进入 Codex 的初始工具列表，不必先 tool_search。
    omit_tools_from = @('deferred')
}
$overrides = @()
foreach ($key in $values.Keys) {
    $encodedValue = ConvertTo-Json -InputObject $values[$key] -Compress
    $overrides += @('-c', "mcp_servers.cc_team.$key=$encodedValue")
}
# 等待类返回的篇幅与这些工具的输出预算配套，多个工作者的报告不被 Codex 截断。
foreach ($tool in @('team_dispatch', 'team_wait', 'team_send', 'team_reply', 'team_resume', 'team_review', 'team_result', 'team_diff', 'team_status')) {
    $overrides += @('-c', "mcp_servers.cc_team.tools.$tool.output_token_limit=40000")
}
foreach ($property in $registration.env.PSObject.Properties) {
    # team_wait 的等待上限与上面的 tool_timeout_sec 配套、返回篇幅与输出预算配套，单独覆盖。
    if ($property.Name -in @('CC_TEAM_WAIT_TIMEOUT_MS', 'CC_TEAM_RESPONSE_BYTES')) { continue }
    $encodedValue = ConvertTo-Json -InputObject $property.Value -Compress
    $overrides += @('-c', "mcp_servers.cc_team.env.$($property.Name)=$encodedValue")
}
$overrides += @('-c', 'mcp_servers.cc_team.env.CC_TEAM_WAIT_TIMEOUT_MS="570000"')
$overrides += @('-c', 'mcp_servers.cc_team.env.CC_TEAM_RESPONSE_BYTES="96000"')

# 仅本次 Codex 启动生效，不改用户级配置、PATH 或模型设置。
if ($teamConfig.codexExecutable -match '\.[cm]?js$') {
    & $nodeExecutable $teamConfig.codexExecutable -C $projectDirectory @overrides @CodexArguments
} else {
    & $teamConfig.codexExecutable -C $projectDirectory @overrides @CodexArguments
}
exit $LASTEXITCODE

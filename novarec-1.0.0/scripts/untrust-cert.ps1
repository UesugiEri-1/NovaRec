param([string]$Thumbprint = "")
# 移除对 NovaRec 自签名证书的信任（撤销 scripts/trust-cert.ps1 的效果）
$ErrorActionPreference = "Stop"
if (-not $Thumbprint) {
  $tf = Join-Path $PSScriptRoot "..\.certs\thumbprint.txt"
  if (Test-Path $tf) { $Thumbprint = (Get-Content $tf -Raw).Trim() }
}
if (-not $Thumbprint) { throw "缺少证书指纹，请传入 -Thumbprint" }
foreach ($store in @("Root", "TrustedPublisher", "CA")) {
  $path = "Cert:/CurrentUser/" + $store + "/" + $Thumbprint
  if (Test-Path $path) { Remove-Item $path -Force; "已从 $store 移除" }
}
"完成。"
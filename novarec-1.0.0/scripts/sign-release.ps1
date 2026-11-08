param([Parameter(Mandatory=$true)][string[]]$Paths, [string]$TimestampServer = "http://timestamp.digicert.com")
# 用本机 CurrentUser\\My 里的 NovaRec 自签名证书对文件签名，并输出校验结果
$ErrorActionPreference = "Stop"
$thumbFile = Join-Path $PSScriptRoot "..\.certs\thumbprint.txt"
if (-not (Test-Path $thumbFile)) { throw "未找到证书指纹文件 .certs\thumbprint.txt，请先运行 scripts\create-cert.ps1" }
$thumb = (Get-Content $thumbFile -Raw).Trim()
$cert = Get-Item ("Cert:\CurrentUser\My\" + $thumb)
foreach ($p in $Paths) {
  $full = (Resolve-Path $p).Path
  $r = Set-AuthenticodeSignature -FilePath $full -Certificate $cert -TimestampServer $TimestampServer -HashAlgorithm SHA256
  "SIGNED " + $full + " status=" + $r.Status
}
foreach ($p in $Paths) {
  $full = (Resolve-Path $p).Path
  $sig = Get-AuthenticodeSignature -FilePath $full
  "VERIFY " + $full + " status=" + $sig.Status + " signer=" + $sig.SignerCertificate.Subject
}
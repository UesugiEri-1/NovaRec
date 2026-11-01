param([string]$Subject = "CN=NovaRec, O=NovaRec, OU=Desktop, C=CN")
# 创建 NovaRec 自签名代码签名证书（仅用于本机/内部分发；Windows SmartScreen 仍会提示未知发布者，除非手动信任证书）
$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "..\.certs"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$existing = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Subject } | Select-Object -First 1
if ($existing) { $cert = $existing } else {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -FriendlyName "NovaRec Self-Signed Code Signing" -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable -KeyUsage DigitalSignature -NotAfter (Get-Date).AddYears(5) -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
}
$cerPath = Join-Path $dir "NovaRec-CodeSigning.cer"
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
Set-Content -Path (Join-Path $dir "thumbprint.txt") -Value $cert.Thumbprint -Encoding ascii
Set-Content -Path (Join-Path $dir "subject.txt") -Value $cert.Subject -Encoding utf8
"CERT_THUMBPRINT=" + $cert.Thumbprint
"CERT_SUBJECT=" + $cert.Subject
"CERT_FILE=" + (Resolve-Path $cerPath).Path
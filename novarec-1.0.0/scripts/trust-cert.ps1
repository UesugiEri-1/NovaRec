param([string]$CerPath = (Join-Path $PSScriptRoot "..\.certs\NovaRec-CodeSigning.cer"), [string]$VerifyPath = "")
# 把 NovaRec 的自签名代码签名证书装进“当前用户”的受信任根存储，使已签名程序显示“已验证的发布者”。
# 注意：Windows 会弹出“安全警告”确认框，这是系统强制的用户确认，请点“是”完成信任；此操作只影响当前 Windows 用户。
$ErrorActionPreference = "Stop"
if (-not (Test-Path $CerPath)) { throw "未找到证书文件：$CerPath" }
$cer = (Resolve-Path $CerPath).Path
"即将信任证书：$cer"
"如果弹出 Windows 安全警告，请点“是”。"
certutil -addstore -user Root $cer
certutil -addstore -user TrustedPublisher $cer
if ($VerifyPath -and (Test-Path $VerifyPath)) {
  $sig = Get-AuthenticodeSignature -FilePath (Resolve-Path $VerifyPath).Path
  "验证结果：" + $sig.Status
  "签名者：" + $sig.SignerCertificate.Subject
}
"完成。若仍显示未知发布者，请重新打开程序或刷新图标缓存。"
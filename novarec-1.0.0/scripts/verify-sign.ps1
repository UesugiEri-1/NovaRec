param([string[]]$Paths)
$ErrorActionPreference = "Stop"
foreach ($p in $Paths) {
  $full = (Resolve-Path $p).Path
  $sig = Get-AuthenticodeSignature -FilePath $full
  "PATH=" + $full
  "STATUS=" + $sig.Status
  "MESSAGE=" + $sig.StatusMessage
  "SIGNER=" + $sig.SignerCertificate.Subject
  "TIMESTAMPER=" + $sig.TimeStamperCertificate.Subject
}
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -like "*NovaRec*" } | ForEach-Object { "ROOT_STORE=" + $_.Thumbprint }
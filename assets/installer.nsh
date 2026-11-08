; NovaRec 安装器自定义脚本（electron-builder nsis.include）
; 背景：本机（以及其他带「未签名程序禁止写 C 盘」类安全策略的机器）上，NSIS 安装器
; 无法把文件写进 %LOCALAPPDATA%\Programs\NovaRec，静默安装会直接以 exit code 2 失败。
; 处理：在 .onInit 的 customInit 阶段探测默认目录是否真的可写（建目录 + 写测试文件），
; 不可写则把默认安装目录换成 D:\NovaRec（用户仍可在安装界面里改路径）。
!macro customInit
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors novarecDefaultDirFail 0
  ClearErrors
  FileOpen $R0 "$INSTDIR\.novarec-write-test" w
  IfErrors novarecDefaultDirFail 0
  FileClose $R0
  Delete "$INSTDIR\.novarec-write-test"
  Goto novarecDefaultDirDone
  novarecDefaultDirFail:
    StrCpy $INSTDIR "D:\NovaRec"
  novarecDefaultDirDone:
!macroend

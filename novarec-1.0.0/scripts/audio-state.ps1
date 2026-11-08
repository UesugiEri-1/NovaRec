# NovaRec 系统音频端点辅助脚本（WASAPI CoreAudio COM）
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/audio-state.ps1 -Action state
#   powershell ... -File scripts/audio-state.ps1 -Action unmute [-Volume 0.3]
#   powershell ... -File scripts/audio-state.ps1 -Action mute
# 输出（每行 KEY=VALUE，便于解析）:
#   AUDIO_MUTE=True|False
#   AUDIO_VOLUME=0.30
#   AUDIO_CHANNELS=2
#   AUDIO_ID={0.0.0.00000000}.{...}
#   AUDIO_HR=0
param(
  [ValidateSet("state", "mute", "unmute")]
  [string]$Action = "state",
  [double]$Volume = -1
)
$ErrorActionPreference = "Stop"
$code = @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(Guid pguidEventContext);
    int VolumeStepDown(Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

public static class NovaAudio {
    static IAudioEndpointVolume Open() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        if (hr != 0 || dev == null) throw new Exception("no default render device hr=0x" + hr.ToString("X8"));
        var iid = typeof(IAudioEndpointVolume).GUID;
        object obj;
        dev.Activate(ref iid, 1, IntPtr.Zero, out obj);
        if (obj == null) throw new Exception("activate failed");
        return (IAudioEndpointVolume)obj;
    }
    public static bool GetMute() { bool m; Open().GetMute(out m); return m; }
    public static float GetVolume() { float v; Open().GetMasterVolumeLevelScalar(out v); return v; }
    public static int GetChannels() { int c; Open().GetChannelCount(out c); return c; }
    public static string GetId() { var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject()); IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev); string id; dev.GetId(out id); return id; }
    public static void SetMute(bool mute) { var v = Open(); var g = Guid.Empty; v.SetMute(mute, g); }
    public static void SetVolume(float scalar) { var v = Open(); var g = Guid.Empty; v.SetMasterVolumeLevelScalar(scalar, g); }
}
"@
Add-Type -TypeDefinition $code -Language CSharp | Out-Null
try {
  if ($Action -eq "mute") {
    if ($Volume -ge 0) { [NovaAudio]::SetVolume([float]$Volume) }
    [NovaAudio]::SetMute($true)
  }
  elseif ($Action -eq "unmute") {
    [NovaAudio]::SetMute($false)
    if ($Volume -ge 0) { [NovaAudio]::SetVolume([float]$Volume) }
  }
  Write-Output ("AUDIO_MUTE=" + [NovaAudio]::GetMute())
  Write-Output ("AUDIO_VOLUME=" + ([math]::Round([NovaAudio]::GetVolume(), 4)).ToString([System.Globalization.CultureInfo]::InvariantCulture))
  Write-Output ("AUDIO_CHANNELS=" + [NovaAudio]::GetChannels())
  Write-Output ("AUDIO_ID=" + [NovaAudio]::GetId())
  Write-Output "AUDIO_HR=0"
} catch {
  Write-Output ("AUDIO_ERROR=" + $_.Exception.Message)
  Write-Output "AUDIO_HR=1"
}

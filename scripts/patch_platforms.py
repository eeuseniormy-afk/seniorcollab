"""Ajusta os arquivos gerados pelo `flutter create` (permissões, nome, versões mínimas)."""
import pathlib, re

root = pathlib.Path(__file__).resolve().parent.parent

# ---------- Android ----------
man = root / "android/app/src/main/AndroidManifest.xml"
s = man.read_text()
perms = [
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.WAKE_LOCK",
]
block = "".join(f'    <uses-permission android:name="{p}"/>\n' for p in perms if p not in s)
s = s.replace("<application", block + "    <application", 1)
s = re.sub(r'android:label="[^"]*"', 'android:label="SeniorCollab"', s, count=1)
if "requestLegacyExternalStorage" not in s:
    s = s.replace("<application", '<application\n        android:requestLegacyExternalStorage="true"', 1)
man.write_text(s)

for name in ["android/app/build.gradle.kts", "android/app/build.gradle"]:
    g = root / name
    if g.exists():
        t = g.read_text()
        t = re.sub(r"minSdk\s*=\s*flutter\.minSdkVersion", "minSdk = 24", t)
        t = re.sub(r"minSdkVersion\s+flutter\.minSdkVersion", "minSdkVersion 24", t)
        g.write_text(t)

# ---------- iOS ----------
plist = root / "ios/Runner/Info.plist"
p = plist.read_text()
keys = {
    "NSCameraUsageDescription": "O SeniorCollab usa a câmera para gravar seus takes.",
    "NSMicrophoneUsageDescription": "O SeniorCollab usa o microfone para gravar o áudio dos seus takes.",
    "NSPhotoLibraryUsageDescription": "O SeniorCollab abre vídeos da sua galeria para fazer duetos.",
    "NSPhotoLibraryAddUsageDescription": "O SeniorCollab salva os vídeos exportados na sua galeria.",
}
add = "".join(f"\t<key>{k}</key>\n\t<string>{v}</string>\n" for k, v in keys.items() if k not in p)
p = p.replace("<dict>", "<dict>\n" + add, 1)
p = re.sub(r"(<key>CFBundleDisplayName</key>\s*<string>)[^<]*(</string>)", r"\1SeniorCollab\2", p)
plist.write_text(p)

pbx = root / "ios/Runner.xcodeproj/project.pbxproj"
x = pbx.read_text()
x = re.sub(r"IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;", "IPHONEOS_DEPLOYMENT_TARGET = 15.0;", x)
pbx.write_text(x)
pod = root / "ios/Podfile"
if pod.exists():
    t = pod.read_text()
    t = re.sub(r"^#?\s*platform :ios, '[0-9.]+'", "platform :ios, '15.0'", t, flags=re.M)
    pod.write_text(t)
print("patched")
